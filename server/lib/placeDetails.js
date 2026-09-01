import { getStore } from "./db.js";
import { reverseGeocode } from "./sources/nominatim.js";
import { fetchJson } from "./http.js";
import { describeTags, getCategory } from "./categories.js";

/**
 * Place details, built only from data we actually have.
 *
 * The previous implementation invented ratings, review text, phone numbers and
 * Instagram handles from a hash of the coordinates, and illustrated every place
 * with the same stock photos. That is worse than showing nothing, because a
 * user cannot tell the invented fields from the real ones. Everything below is
 * either a real OSM tag, a real Wikimedia image, or - when a Google Places key
 * is configured - real Google data, and each field is labelled with its source.
 */

const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY || "";
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

  push("Opening hours", tags.opening_hours);
  push("Cuisine", tags.cuisine?.replace(/;/g, ", "));
  push("Takeaway", tags.takeaway);
  push("Delivery", tags.delivery);
  push("Outdoor seating", tags.outdoor_seating);
  push("Air conditioning", tags.air_conditioning);
  push("Wi-Fi", tags["internet_access"]);
  push("Wheelchair access", tags.wheelchair);
  push("Smoking", tags.smoking);
  push("Toilets", tags["toilets"]);
  push("Parking", tags["parking"]);
  push("Operator", tags.operator);
  push("Brand", tags.brand);
  push("Religion", tags.religion);
  push("Stars", tags.stars);
  push("Rooms", tags.rooms);

  const payments = Object.keys(tags)
    .filter((key) => key.startsWith("payment:") && /^(yes|only)$/i.test(String(tags[key])))
    .map((key) => key.replace("payment:", "").replace(/_/g, " "));

  if (payments.length) {
    facts.push({ label: "Payment", value: payments.join(", ") });
  }

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

async function fetchGooglePlace(name, lat, lng) {
  if (!GOOGLE_API_KEY) {
    return null;
  }

  try {
    const searchParams = new URLSearchParams({
      input: name,
      inputtype: "textquery",
      locationbias: `circle:200@${lat},${lng}`,
      fields: "place_id",
      key: GOOGLE_API_KEY
    });

    const found = await fetchJson(
      `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?${searchParams.toString()}`,
      { timeoutMs: 6000, label: "google/findplace" }
    );

    const placeId = found.candidates?.[0]?.place_id;

    if (!placeId) {
      return null;
    }

    const detailParams = new URLSearchParams({
      place_id: placeId,
      fields:
        "name,formatted_address,rating,user_ratings_total,reviews,website,formatted_phone_number,opening_hours,photos,url,price_level",
      key: GOOGLE_API_KEY
    });

    const details = await fetchJson(
      `https://maps.googleapis.com/maps/api/place/details/json?${detailParams.toString()}`,
      { timeoutMs: 6000, label: "google/details" }
    );

    return details.result || null;
  } catch (error) {
    console.warn(`[details] Google Places lookup failed: ${error.message}`);
    return null;
  }
}

const PRICE_LEVEL_LABELS = ["Free", "$", "$$", "$$$", "$$$$"];

export async function buildPlaceDetails({ id, lat, lng, name, type }) {
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
    address: stored?.address || ""
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

  // Reverse geocode only when OSM tags gave us nothing usable.
  if (!resolved.address) {
    try {
      const reverse = await reverseGeocode(resolved.lat, resolved.lng, { timeoutMs: 6000 });
      resolved.address = reverse?.display_name || "";
    } catch {
      resolved.address = "";
    }
  }

  const google = await fetchGooglePlace(resolved.name, resolved.lat, resolved.lng);

  const contacts = {
    phone: normalizePhone(
      google?.formatted_phone_number || firstTag(tags, ["phone", "contact:phone", "contact:mobile"])
    ),
    website: normalizeWebsite(google?.website || firstTag(tags, ["website", "contact:website", "url"])),
    instagram: normalizeInstagram(firstTag(tags, ["contact:instagram", "instagram"])),
    facebook: normalizeWebsite(firstTag(tags, ["contact:facebook", "facebook"])),
    email: firstTag(tags, ["email", "contact:email"])
  };

  const images = extractImages(tags, resolved.name);
  const category = getCategory(resolved.categoryId);

  const reviews = (google?.reviews || []).slice(0, 5).map((review) => ({
    author: review.author_name,
    rating: review.rating,
    text: review.text,
    relativeTime: review.relative_time_description
  }));

  if (google?.photos?.length) {
    google.photos.slice(0, 5).forEach((photo, index) => {
      images.push({
        url: `https://maps.googleapis.com/maps/api/place/photo?maxwidth=1000&photo_reference=${photo.photo_reference}&key=${GOOGLE_API_KEY}`,
        alt: `${resolved.name} photo ${index + 1}`,
        credit: "Google Places"
      });
    });
  }

  const detail = {
    id: resolved.id,
    name: google?.name || resolved.name,
    address: resolved.address || google?.formatted_address || "",
    coordinates: { lat: resolved.lat, lng: resolved.lng },
    categoryId: resolved.categoryId,
    categoryLabel: category?.label || "Other",
    type: resolved.tagValue,
    images,
    facts: extractFacts(tags),
    contacts,
    links: {
      googleMaps:
        google?.url ||
        `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
          `${resolved.name} ${resolved.lat},${resolved.lng}`
        )}`,
      directions: `https://www.google.com/maps/dir/?api=1&destination=${resolved.lat},${resolved.lng}`,
      openStreetMap: stored?.osmId
        ? `https://www.openstreetmap.org/${stored.osmType}/${stored.osmId}`
        : `https://www.openstreetmap.org/#map=18/${resolved.lat}/${resolved.lng}`
    },
    // `null` means "we genuinely do not know", which the UI renders as such
    // rather than filling in a plausible-looking number.
    rating: typeof google?.rating === "number" ? google.rating : null,
    reviewCount: typeof google?.user_ratings_total === "number" ? google.user_ratings_total : null,
    priceLevel:
      typeof google?.price_level === "number" ? PRICE_LEVEL_LABELS[google.price_level] || null : null,
    reviews,
    openingHours: google?.opening_hours?.weekday_text || (tags.opening_hours ? [tags.opening_hours] : []),
    openNow: typeof google?.opening_hours?.open_now === "boolean" ? google.opening_hours.open_now : null,
    dataSources: [
      "OpenStreetMap",
      ...(google ? ["Google Places"] : []),
      ...(resolved.address ? ["Nominatim"] : [])
    ].filter((value, index, list) => list.indexOf(value) === index),
    hasRichData: Boolean(google) || images.length > 0 || Object.values(contacts).some(Boolean)
  };

  if (detailCache.size >= DETAIL_CACHE_MAX) {
    detailCache.delete(detailCache.keys().next().value);
  }

  detailCache.set(cacheKey, detail);
  return detail;
}
