import { getStore } from "./db.js";
import { reverseGeocode } from "./sources/nominatim.js";
import { fetchJson } from "./http.js";
import { describeTags, getCategory } from "./categories.js";
import { fetchGoogleMapsCard, googleMapsResolverEnabled } from "./sources/googleMaps.js";
import {
  fetchPlaceByPlaceId,
  googlePlacesApiEnabled,
  searchNearbyPlaceId,
  searchTextPlaceId
} from "./googlePlacesApi.js";
import { analyzeReviews, buildAttributes } from "./reviewInsights.js";

/**
 * Place details, built only from data we actually have.
 *
 * The previous implementation invented ratings, review text, phone numbers and
 * Instagram handles from a hash of the coordinates, and illustrated every place
 * with the same stock photos. That is worse than showing nothing, because a
 * user cannot tell the invented fields from the real ones. Everything below is
 * a real OSM tag, a real Wikimedia image, a field read off the place's own
 * Google Maps card, or - when a Places API key is configured - real Google
 * Places data, and each field is labelled with its source.
 *
 * Sources, in the order they are consulted:
 *
 * 1. OSM tags - opening hours, phone, website, payment, cuisine, images.
 * 2. The Google Maps card (`sources/googleMaps.js`) - rating, review count,
 *    phone, website, category, weekly hours, open-now, and the Place ID. Free,
 *    one cached request, but only accepted when it lands within 300 m of the
 *    place *and* shares its name - the wrong card with a real source label is
 *    exactly the kind of fabrication bug 11 removed.
 * 3. Google Places API (`googlePlacesApi.js`) - photos, price, review text,
 *    Google's review summary and structured attributes. Keyed, optional.
 * 4. Review analysis (`reviewInsights.js`) - pros, cons, complaints, best
 *    menu, waiting time, crowd, parking, payment, findability - counted from
 *    the review texts in (3), and labelled with how many reviews said so.
 *
 * `null` throughout means "we genuinely do not know"; the UI renders it as such.
 */

const OSM_API_BASE = process.env.OSM_API_BASE || "https://api.openstreetmap.org/api/0.6";
const detailCache = new Map();
const DETAIL_CACHE_MAX = 500;

/**
 * Nominatim results carry only the primary tag, so a place discovered that way
 * has no opening hours, phone or website. The OSM element API returns the full
 * tag set for a known node/way/relation in well under a second, so fetch it and
 * write it back to the cache - the next view of this place needs no request.
 */
async function fetchOsmElement(osmType, osmId) {
  if (!osmType || !osmId) {
    return null;
  }

  const type = String(osmType).toLowerCase();

  if (!["node", "way", "relation"].includes(type)) {
    return null;
  }

  try {
    const data = await fetchJson(`${OSM_API_BASE}/${type}/${osmId}.json`, {
      timeoutMs: 6000,
      label: "osm/element"
    });

    return data.elements?.[0] || null;
  } catch (error) {
    console.warn(`[details] OSM lookup failed for ${type}/${osmId}: ${error.message}`);
    return null;
  }
}

async function fetchOsmTags(osmType, osmId) {
  const element = await fetchOsmElement(osmType, osmId);
  return element?.tags || null;
}

/** Ids are `node/123` / `way/123` / `relation/123`, shared across sources. */
function parseOsmId(id) {
  const match = /^(node|way|relation)\/(\d+)$/.exec(String(id || ""));
  return match ? { osmType: match[1], osmId: match[2] } : null;
}

/** Tags that actually carry something worth showing in the detail panel. */
const DETAIL_TAG_KEYS = [
  "opening_hours",
  "phone",
  "contact:phone",
  "website",
  "contact:website",
  "cuisine",
  "image",
  "wikimedia_commons",
  "internet_access",
  "wheelchair",
  "outdoor_seating",
  "takeaway",
  "delivery",
  "brand",
  "operator",
  "stars"
];

function hasDetailTags(tags = {}) {
  return DETAIL_TAG_KEYS.some((key) => Boolean(tags[key]));
}

function firstTag(tags, keys) {
  for (const key of keys) {
    const value = tags[key];

    if (value) {
      return String(value);
    }
  }

  return "";
}

function normalizeInstagram(value) {
  if (!value) {
    return "";
  }

  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  return `https://instagram.com/${String(value).replace(/^@/, "")}`;
}

function normalizeWebsite(value) {
  if (!value) {
    return "";
  }

  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function normalizePhone(value) {
  return value ? String(value).replace(/\s+/g, " ").trim() : "";
}

/** Facts worth surfacing, drawn straight from OSM tags. */
function extractFacts(tags) {
  const facts = [];

  const push = (label, value) => {
    if (value) {
      facts.push({ label, value: String(value) });
    }
  };

  push("Cuisine", tags.cuisine?.replace(/;/g, ", "));
  push("Takeaway", tags.takeaway);
  push("Delivery", tags.delivery);
  push("Outdoor seating", tags.outdoor_seating);
  push("Air conditioning", tags.air_conditioning);
  push("Wi-Fi", tags["internet_access"]);
  push("Wheelchair access", tags.wheelchair);
  push("Smoking", tags.smoking);
  push("Toilets", tags["toilets"]);
  push("Operator", tags.operator);
  push("Brand", tags.brand);
  push("Religion", tags.religion);
  push("Stars", tags.stars);
  push("Rooms", tags.rooms);

  return facts;
}

/** Real images only: an OSM `image` tag, or a Wikimedia Commons file. */
function extractImages(tags, name) {
  const images = [];

  if (tags.image && /^https?:\/\//i.test(tags.image)) {
    images.push({ url: tags.image, alt: name, credit: "OpenStreetMap `image` tag" });
  }

  const commons = tags.wikimedia_commons || "";

  if (commons.startsWith("File:")) {
    const file = encodeURIComponent(commons.slice("File:".length).replace(/ /g, "_"));
    images.push({
      url: `https://commons.wikimedia.org/wiki/Special:FilePath/${file}?width=1000`,
      alt: name,
      credit: "Wikimedia Commons"
    });
  }

  return images;
}

/**
 * A "name" that is really a street. OSM POIs with no `name` tag used to be
 * labelled by the first part of their Nominatim address, so the cache held
 * cafes called "Jalan Garuda". Such a place has nothing to look up by name -
 * Google would only return the street - and the panel must say so instead.
 */
export function isStreetLikeName(name) {
  return /^(jalan|jln?[.]?|gang|gg[.]?|blok)(?![a-z])/i.test(String(name || "").trim());
}

/** Google's Indonesian day names, as the embed card labels them. */
const DAY_LABELS = { 1: "Senin", 2: "Selasa", 3: "Rabu", 4: "Kamis", 5: "Jumat", 6: "Sabtu", 7: "Minggu" };

function hoursFromCard(card) {
  if (!card?.openingHours?.length) {
    return [];
  }

  return card.openingHours.map((entry) => `${DAY_LABELS[entry.dayIndex] || entry.day}: ${entry.text}`);
}

export async function buildPlaceDetails({ id, lat, lng, name, type, googleId = "", placeId = "", address = "" }) {
  const store = getStore();
  let stored = id ? store.getPlaceById(id) : null;

  // The cache is per-area, so a place can be requested (bookmark, shared link,
  // an area that has since been evicted) without being cached. Rebuild it from
  // the OSM element itself rather than answering "Unnamed place".
  if (!stored) {
    const parsed = parseOsmId(id);

    if (parsed) {
      const element = await fetchOsmElement(parsed.osmType, parsed.osmId);

      if (element) {
        const elementLat = Number(element.lat ?? element.center?.lat ?? lat);
        const elementLng = Number(element.lon ?? element.center?.lon ?? lng);
        const tags = element.tags || {};

        if (Number.isFinite(elementLat) && Number.isFinite(elementLng)) {
          stored = {
            id,
            osmType: parsed.osmType,
            osmId: parsed.osmId,
            name: tags.name || name || "Unnamed place",
            lat: elementLat,
            lng: elementLng,
            categoryId: describeTags(tags)?.categoryId || "other",
            tagKey: describeTags(tags)?.key || null,
            tagValue: describeTags(tags)?.value || type || "place",
            tags,
            address: "",
            source: "osm-api"
          };

          try {
            store.upsertPlaces([stored]);
          } catch (error) {
            console.warn(`[details] could not cache ${id}: ${error.message}`);
          }
        }
      }
    }
  }

  const resolved = {
    id: stored?.id || id || `point/${lat},${lng}`,
    name: stored?.name || name || "Unnamed place",
    lat: stored?.lat ?? lat,
    lng: stored?.lng ?? lng,
    categoryId: stored?.categoryId || "other",
    tagValue: stored?.tagValue || type || "place",
    tags: stored?.tags || {},
    address: stored?.address || address || ""
  };

  const cacheKey = resolved.id;

  if (detailCache.has(cacheKey)) {
    return detailCache.get(cacheKey);
  }

  let tags = resolved.tags || {};

  // Nothing worth showing yet - go and get the full tag set from OSM.
  if (stored?.osmId && !hasDetailTags(tags)) {
    const fullTags = await fetchOsmTags(stored.osmType, stored.osmId);

    if (fullTags) {
      tags = { ...tags, ...fullTags };

      try {
        store.upsertPlaces([{ ...stored, tags, source: stored.source }]);
      } catch (error) {
        console.warn(`[details] could not cache enriched tags: ${error.message}`);
      }
    }
  }

  resolved.tags = tags;

  // Reverse geocode only when nothing else gave us an address.
  if (!resolved.address) {
    try {
      const reverse = await reverseGeocode(resolved.lat, resolved.lng, { timeoutMs: 6000 });
      resolved.address = reverse?.display_name || "";
    } catch {
      resolved.address = "";
    }
  }

  // --- Google Maps card: rating, count, phone, website, hours, Place ID -----
  const unnamed = !resolved.name || resolved.name === "Unnamed place" || isStreetLikeName(resolved.name);

  let card = null;
  // "Could not reach Google" and "Google's card was for somewhere else" are
  // different facts, and the panel should say which one happened.
  let cardError = "";

  // An unnamed place is not looked up by name: the only name we hold is its
  // street, and the card for a street is not the card for the cafe on it.
  if (googleMapsResolverEnabled() && !unnamed) {
    try {
      card = await fetchGoogleMapsCard({
        name: resolved.name,
        address: resolved.address,
        lat: resolved.lat,
        lng: resolved.lng
      });
    } catch (error) {
      cardError = error.message || "request failed";
      console.warn(`[details] Google Maps card failed: ${cardError}`);
    }
  }

  // --- Google Places API: photos, price, reviews, attributes ---------------
  let google = null;

  if (googlePlacesApiEnabled()) {
    // For a named place, its Place ID (from the card) or a text search. For an
    // unnamed one, whatever Google has within 25 m in the same category - the
    // one keyed lookup that can recover a business OSM knows only as "a cafe".
    const knownPlaceId =
      placeId ||
      card?.placeId ||
      (unnamed
        ? await searchNearbyPlaceId(resolved.lat, resolved.lng, resolved.categoryId)
        : await searchTextPlaceId(resolved.name, resolved.lat, resolved.lng));

    if (knownPlaceId) {
      google = await fetchPlaceByPlaceId(knownPlaceId);
    }
  }

  const contacts = {
    phone: normalizePhone(
      google?.phone || card?.phone || firstTag(tags, ["phone", "contact:phone", "contact:mobile"])
    ),
    website: normalizeWebsite(google?.website || card?.website || firstTag(tags, ["website", "contact:website", "url"])),
    instagram: normalizeInstagram(firstTag(tags, ["contact:instagram", "instagram"])),
    facebook: normalizeWebsite(firstTag(tags, ["contact:facebook", "facebook"])),
    email: firstTag(tags, ["email", "contact:email"])
  };

  const images = extractImages(tags, resolved.name);

  // Served through our own proxy so the API key never reaches the browser.
  (google?.photos || []).forEach((photo, index) => {
    images.push({
      url: `/api/place/photo?name=${encodeURIComponent(photo.name)}&w=1000`,
      alt: `${resolved.name} photo ${index + 1}`,
      credit: photo.attribution ? `Google · ${photo.attribution}` : "Google"
    });
  });

  const category = getCategory(resolved.categoryId);

  const reviews = (google?.reviews || []).slice(0, 5);
  const rating = google?.rating ?? card?.rating ?? null;
  const reviewCount = google?.reviewCount ?? card?.reviewCount ?? null;

  const insights = analyzeReviews(reviews, {
    reviewCount,
    googleSummary: google?.summary?.reviews || google?.summary?.generative || google?.summary?.editorial || ""
  });

  const attributes = buildAttributes({ google, osmTags: tags, insights });

  // Hours: the API's localised weekday text, else the card's weekly table,
  // else the raw OSM opening_hours string.
  const openingHours = google?.openingHours?.length
    ? google.openingHours
    : card?.openingHours?.length
      ? hoursFromCard(card)
      : tags.opening_hours
        ? [tags.opening_hours]
        : [];

  const openNow = google?.openNow ?? card?.openNow ?? null;

  /** Where each headline field came from, for the UI to print beside it. */
  const provenance = {
    rating: google?.rating != null ? "google-places" : card?.rating != null ? "google-maps" : null,
    reviewCount: google?.reviewCount != null ? "google-places" : card?.reviewCount != null ? "google-maps" : null,
    price: google?.priceRange || google?.priceLevel ? "google-places" : null,
    hours: google?.openingHours?.length
      ? "google-places"
      : card?.openingHours?.length
        ? "google-maps"
        : tags.opening_hours
          ? "osm"
          : null,
    phone: google?.phone ? "google-places" : card?.phone ? "google-maps" : contacts.phone ? "osm" : null,
    website: google?.website ? "google-places" : card?.website ? "google-maps" : contacts.website ? "osm" : null,
    photos: google?.photos?.length ? "google-places" : images.length ? "osm" : null,
    reviews: reviews.length ? "google-places" : null
  };

  const dataSources = [
    "OpenStreetMap",
    ...(resolved.address && !stored?.address ? ["Nominatim"] : []),
    ...(card ? ["Google Maps"] : []),
    ...(google ? ["Google Places API"] : []),
    ...(images.some((image) => image.credit === "Wikimedia Commons") ? ["Wikimedia Commons"] : [])
  ].filter((value, index, list) => list.indexOf(value) === index);

  const detail = {
    id: resolved.id,
    name: google?.name || card?.name || resolved.name,
    address: google?.address || card?.address || resolved.address || "",
    coordinates: { lat: resolved.lat, lng: resolved.lng },
    categoryId: resolved.categoryId,
    categoryLabel: category?.label || "Other",
    type: resolved.tagValue,
    images,
    facts: extractFacts(tags),
    contacts,
    links: {
      googleMaps:
        google?.googleMapsUri ||
        (card?.placeId
          ? `https://www.google.com/maps/place/?q=place_id:${card.placeId}`
          : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
              `${resolved.name} ${resolved.lat},${resolved.lng}`
            )}`),
      directions: `https://www.google.com/maps/dir/?api=1&destination=${resolved.lat},${resolved.lng}`,
      openStreetMap: stored?.osmId
        ? `https://www.openstreetmap.org/${stored.osmType}/${stored.osmId}`
        : `https://www.openstreetmap.org/#map=18/${resolved.lat}/${resolved.lng}`,
      // Where a missing name gets fixed for good - for this app and every other
      // OSM-based one.
      editOpenStreetMap: stored?.osmId
        ? `https://www.openstreetmap.org/edit?${stored.osmType}=${stored.osmId}`
        : `https://www.openstreetmap.org/edit#map=19/${resolved.lat}/${resolved.lng}`
    },
    // True when the only "name" we have is a street or nothing at all.
    unnamed: unnamed && !google?.name,
    // `null` means "we genuinely do not know", which the UI renders as such
    // rather than filling in a plausible-looking number.
    rating,
    reviewCount,
    priceLevel: google?.priceLevel || null,
    priceRange: google?.priceRange || null,
    reviews,
    openingHours,
    openNow,
    statusText: card?.statusText || "",
    google: card || google
      ? {
          placeId: google?.placeId || card?.placeId || placeId || "",
          googleId: card?.googleId || googleId || "",
          categoryLabel: card?.categoryLabel || "",
          plusCode: card?.plusCode || ""
        }
      : null,
    insights,
    attributes,
    provenance,
    dataSources,
    hasRichData:
      Boolean(google) || Boolean(card) || images.length > 0 || Object.values(contacts).some(Boolean),
    // What is missing and why, so the panel can say it in one honest line.
    limitations: [
      ...(!googlePlacesApiEnabled()
        ? ["Photos, price, review text and Google's parking/payment attributes need GOOGLE_PLACES_API_KEY."]
        : []),
      ...(unnamed && !google?.name
        ? [
            "This place has no name in OpenStreetMap - it is shown by its street - so there is nothing to look up. If you know it, add its name on OpenStreetMap."
          ]
        : []),
      ...(googleMapsResolverEnabled() && !card && !unnamed
        ? [
            cardError
              ? `Google Maps could not be reached for this place (${cardError}); rating, hours and contact may be missing.`
              : "No Google Maps card matched this place closely enough to trust."
          ]
        : [])
    ]
  };

  if (detailCache.size >= DETAIL_CACHE_MAX) {
    detailCache.delete(detailCache.keys().next().value);
  }

  detailCache.set(cacheKey, detail);
  return detail;
}
