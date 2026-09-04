import { fetchJson, fetchWithTimeout } from "./http.js";

/**
 * Google Places API (New) - the official, keyed source for what the public
 * Maps embed does not carry: photos, price, review text, and Google's own
 * structured attributes (parking, payment, crowd, atmosphere).
 *
 * Entirely optional. Without GOOGLE_PLACES_API_KEY every function here returns
 * null and the detail panel says those fields are unknown; nothing is inferred
 * in their place. With a key, the Place ID read from the embed card is used
 * directly, so no search call is spent - one `places/{id}` GET per place, and
 * that is cached upstream in placeDetails.
 *
 * Pricing note for whoever turns this on: reviews, summaries and the attribute
 * fields sit in the higher "Enterprise + Atmosphere" SKU. Check current rates
 * and set a quota before deploying; the field mask below asks for exactly what
 * the panel shows and nothing more.
 */
const API_KEY = process.env.GOOGLE_PLACES_API_KEY || "";
const BASE = "https://places.googleapis.com/v1";

/** Only what the panel renders. Every extra field is money and latency. */
const FIELD_MASK = [
  "id",
  "displayName",
  "formattedAddress",
  "googleMapsUri",
  "rating",
  "userRatingCount",
  "priceLevel",
  "priceRange",
  "regularOpeningHours",
  "currentOpeningHours.openNow",
  "nationalPhoneNumber",
  "internationalPhoneNumber",
  "websiteUri",
  "photos",
  "reviews",
  "editorialSummary",
  "reviewSummary",
  "generativeSummary",
  "parkingOptions",
  "paymentOptions",
  "accessibilityOptions",
  "goodForChildren",
  "goodForGroups",
  "outdoorSeating",
  "reservable",
  "restroom",
  "dineIn",
  "takeout",
  "delivery",
  "liveMusic",
  "menuForChildren",
  "servesVegetarianFood"
].join(",");

export function googlePlacesApiEnabled() {
  return Boolean(API_KEY);
}

function headers(fieldMask) {
  return {
    "X-Goog-Api-Key": API_KEY,
    "X-Goog-FieldMask": fieldMask,
    "Content-Type": "application/json"
  };
}

const PRICE_LEVELS = {
  PRICE_LEVEL_FREE: "Free",
  PRICE_LEVEL_INEXPENSIVE: "$",
  PRICE_LEVEL_MODERATE: "$$",
  PRICE_LEVEL_EXPENSIVE: "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$$"
};

function formatMoney(money) {
  if (!money) {
    return "";
  }

  const units = Number(money.units || 0);
  const currency = money.currencyCode || "";
  const amount = units.toLocaleString("id-ID");

  return currency === "IDR" ? `Rp ${amount}` : `${currency} ${amount}`.trim();
}

function formatPriceRange(range) {
  if (!range) {
    return null;
  }

  const start = formatMoney(range.startPrice);
  const end = formatMoney(range.endPrice);

  if (start && end) {
    return `${start} – ${end}`;
  }

  return start || end || null;
}

/** Turn a `*Options` object of booleans into readable labels, true ones only. */
function trueOptions(options, labels) {
  if (!options) {
    return [];
  }

  return Object.entries(labels)
    .filter(([key]) => options[key] === true)
    .map(([, label]) => label);
}

const PARKING_LABELS = {
  freeParkingLot: "free parking lot",
  paidParkingLot: "paid parking lot",
  freeStreetParking: "free street parking",
  paidStreetParking: "paid street parking",
  valetParking: "valet",
  freeGarageParking: "free garage",
  paidGarageParking: "paid garage"
};

const PAYMENT_LABELS = {
  acceptsCreditCards: "credit card",
  acceptsDebitCards: "debit card",
  acceptsCashOnly: "cash only",
  acceptsNfc: "contactless / NFC"
};

function normalize(place) {
  if (!place) {
    return null;
  }

  const reviews = (place.reviews || []).map((review) => ({
    author: review.authorAttribution?.displayName || "Google user",
    rating: typeof review.rating === "number" ? review.rating : null,
    text: review.text?.text || review.originalText?.text || "",
    relativeTime: review.relativePublishTimeDescription || "",
    publishTime: review.publishTime || ""
  }));

  return {
    placeId: place.id || "",
    name: place.displayName?.text || "",
    address: place.formattedAddress || "",
    googleMapsUri: place.googleMapsUri || "",
    rating: typeof place.rating === "number" ? place.rating : null,
    reviewCount: typeof place.userRatingCount === "number" ? place.userRatingCount : null,
    priceLevel: PRICE_LEVELS[place.priceLevel] || null,
    priceRange: formatPriceRange(place.priceRange),
    openingHours: place.regularOpeningHours?.weekdayDescriptions || [],
    openNow:
      typeof place.currentOpeningHours?.openNow === "boolean" ? place.currentOpeningHours.openNow : null,
    phone: place.nationalPhoneNumber || place.internationalPhoneNumber || "",
    website: place.websiteUri || "",
    photos: (place.photos || []).slice(0, 8).map((photo) => ({
      name: photo.name,
      widthPx: photo.widthPx,
      heightPx: photo.heightPx,
      attribution: photo.authorAttributions?.[0]?.displayName || ""
    })),
    reviews,
    summary: {
      editorial: place.editorialSummary?.text || "",
      // Google's own summary of what reviewers say - preferred over anything we
      // derive ourselves, because it is drawn from all reviews, not five.
      reviews: place.reviewSummary?.text?.text || "",
      generative: place.generativeSummary?.overview?.text || ""
    },
    attributes: {
      parking: trueOptions(place.parkingOptions, PARKING_LABELS),
      payment: trueOptions(place.paymentOptions, PAYMENT_LABELS),
      goodForChildren: place.goodForChildren ?? null,
      goodForGroups: place.goodForGroups ?? null,
      outdoorSeating: place.outdoorSeating ?? null,
      reservable: place.reservable ?? null,
      restroom: place.restroom ?? null,
      dineIn: place.dineIn ?? null,
      takeout: place.takeout ?? null,
      delivery: place.delivery ?? null,
      liveMusic: place.liveMusic ?? null,
      menuForChildren: place.menuForChildren ?? null,
      servesVegetarianFood: place.servesVegetarianFood ?? null,
      wheelchair: place.accessibilityOptions?.wheelchairAccessibleEntrance ?? null
    }
  };
}

/** Full details for a known Place ID. Null without a key or on any failure. */
export async function fetchPlaceByPlaceId(placeId, { timeoutMs = 7000 } = {}) {
  if (!API_KEY || !placeId) {
    return null;
  }

  try {
    const place = await fetchJson(`${BASE}/places/${encodeURIComponent(placeId)}?languageCode=id`, {
      timeoutMs,
      headers: headers(FIELD_MASK),
      label: "google-places/details"
    });

    return normalize(place);
  } catch (error) {
    console.warn(`[google-places] details failed for ${placeId}: ${error.message}`);
    return null;
  }
}

/**
 * Find a Place ID by name near a point - only needed when the embed card did
 * not give one. Costs a Text Search call, so it is the fallback, not the rule.
 */
export async function searchTextPlaceId(text, lat, lng, { timeoutMs = 7000 } = {}) {
  if (!API_KEY || !text) {
    return "";
  }

  try {
    const body = {
      textQuery: text,
      languageCode: "id",
      maxResultCount: 1,
      ...(Number.isFinite(lat) && Number.isFinite(lng)
        ? { locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 300 } } }
        : {})
    };

    const response = await fetchWithTimeout(`${BASE}/places:searchText`, {
      method: "POST",
      timeoutMs,
      headers: headers("places.id,places.displayName"),
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`responded ${response.status}`);
    }

    const data = await response.json();
    return data.places?.[0]?.id || "";
  } catch (error) {
    console.warn(`[google-places] text search failed: ${error.message}`);
    return "";
  }
}

/** Our category ids → Places API primary types, for the nearby lookup. */
const NEARBY_TYPES = {
  food: ["restaurant", "fast_food_restaurant", "meal_takeaway"],
  cafe: ["cafe", "coffee_shop", "bakery", "ice_cream_shop"],
  nightlife: ["bar", "night_club", "pub"],
  shopping: ["shopping_mall", "supermarket", "convenience_store", "store"],
  attraction: ["tourist_attraction", "museum", "art_gallery"],
  outdoor: ["park", "playground"],
  entertainment: ["movie_theater", "amusement_center", "gym"],
  stay: ["hotel", "lodging", "guest_house"],
  worship: ["place_of_worship", "mosque", "church"],
  essential: ["hospital", "pharmacy", "bank", "atm", "gas_station"],
  transport: ["train_station", "bus_station", "transit_station"],
  education: ["school", "university", "library"]
};

/**
 * The Place ID of whatever Google has at a position, for a place OSM knows
 * only as "a cafe here" with no name. Radius 25 m and restricted to the
 * matching category types, so a neighbouring shop cannot be mistaken for it.
 * Costs a Nearby Search call; only used when there is no name to look up.
 */
export async function searchNearbyPlaceId(lat, lng, categoryId, { radius = 25, timeoutMs = 7000 } = {}) {
  if (!API_KEY || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return "";
  }

  const includedTypes = NEARBY_TYPES[categoryId] || [];

  try {
    const response = await fetchWithTimeout(`${BASE}/places:searchNearby`, {
      method: "POST",
      timeoutMs,
      headers: headers("places.id,places.displayName,places.primaryType"),
      body: JSON.stringify({
        languageCode: "id",
        maxResultCount: 1,
        rankPreference: "DISTANCE",
        ...(includedTypes.length ? { includedTypes } : {}),
        locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius } }
      })
    });

    if (!response.ok) {
      throw new Error(`responded ${response.status}`);
    }

    const data = await response.json();
    return data.places?.[0]?.id || "";
  } catch (error) {
    console.warn(`[google-places] nearby search failed: ${error.message}`);
    return "";
  }
}

/**
 * Resolve a photo resource name to a short-lived image URL. Used by the photo
 * proxy route so the API key never reaches the browser: the browser asks our
 * server, our server asks Google with the key, and redirects to the plain
 * googleusercontent URL Google hands back.
 */
export async function resolvePhotoUri(photoName, { maxWidthPx = 1000, timeoutMs = 7000 } = {}) {
  if (!API_KEY || !photoName || !/^places\/[^/]+\/photos\/[^/]+$/.test(photoName)) {
    return "";
  }

  try {
    const params = new URLSearchParams({
      maxWidthPx: String(Math.min(Math.max(Number(maxWidthPx) || 1000, 100), 4800)),
      skipHttpRedirect: "true",
      key: API_KEY
    });

    const data = await fetchJson(`${BASE}/${photoName}/media?${params.toString()}`, {
      timeoutMs,
      label: "google-places/photo"
    });

    return data.photoUri || "";
  } catch (error) {
    console.warn(`[google-places] photo failed: ${error.message}`);
    return "";
  }
}
