import { fetchWithTimeout, sleep } from "../http.js";
import { getStore } from "../db.js";
import { filterByRelevance } from "../addressQuery.js";

/**
 * Resolve free text to an exact position through Google Maps itself.
 *
 * This exists because OpenStreetMap does not hold everything people paste. "MPM
 * Learning Center - Sidoarjo" has no OSM entry; "Jl. Tumapel No.34" is a house
 * number OSM does not carry in Indonesia. Both are one request away in Google
 * Maps, and the person pasting them expects the pin Google would give them.
 *
 * It uses the public embed endpoint - the same request an `<iframe>` embed
 * makes - rather than the full Maps page or the Search page. It is ~3 KB, needs
 * no JavaScript, shows no consent interstitial, and its payload carries the
 * resolved place as a plain array: Google's feature id, the formatted address,
 * and `[lat, lng]`. The full Maps page also embeds coordinates, but the first
 * pair it exposes is the *viewport* centre, which for a search sits several
 * hundred metres from the place; the embed payload carries the place itself.
 * Verified on the same query: page said -7.3970, embed said -7.3907, and the
 * latter is the pin.
 *
 * Be clear about what this is. It is automated access to Google Maps content,
 * which Google's terms restrict, and there is no rate-limit contract - Google
 * can change the payload or block the client at any time without notice. So:
 *
 * - it is one request per *distinct text*, cached in the database afterwards;
 * - live requests are serialised and spaced out;
 * - it never runs on autocomplete keystrokes, only where OSM has come up empty
 *   or where the text carries a house number OSM cannot have;
 * - and it can be switched off with GOOGLE_MAPS_RESOLVER=0.
 *
 * Nothing here is bulk collection. Each place that lands in the cache is one a
 * user asked about, by name, once.
 */
const ENABLED = process.env.GOOGLE_MAPS_RESOLVER !== "0";

const EMBED_URL = "https://www.google.com/maps/embed";

/** Google serves the bot-check to anything that does not look like a browser. */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Spacing between live requests. Cache hits do not wait. */
const MIN_INTERVAL_MS = Number(process.env.GOOGLE_MAPS_MIN_INTERVAL_MS || 800);

/** A resolved place is trusted this long; a miss is retried after a day. */
const HIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * `["0x…:0x…", "<formatted address>", [lat, lng]` - the place record inside
 * the embed payload. The feature id is a pair of hex values; the address is a
 * JSON string literal, so escaped characters are allowed inside it.
 */
const PLACE_RECORD = /\["(0x[0-9a-f]+:0x[0-9a-f]+)","((?:[^"\\]|\\.)*)",\[(-?\d+\.\d+),(-?\d+\.\d+)\]/;

let queueTail = Promise.resolve();
let lastRequestAt = 0;

function schedule(task) {
  const run = queueTail.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);

    if (wait > 0) {
      await sleep(wait);
    }

    lastRequestAt = Date.now();
    return task();
  });

  queueTail = run.then(
    () => undefined,
    () => undefined
  );

  return run;
}

export function googleMapsResolverEnabled() {
  return ENABLED;
}

/** The cache key: the text people type varies in case and spacing only. */
function cacheKey(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function unescapeJsonString(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

function parseEmbedPayload(html) {
  const match = html.match(PLACE_RECORD);

  if (!match) {
    return null;
  }

  const lat = Number(match[3]);
  const lng = Number(match[4]);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
    return null;
  }

  const address = unescapeJsonString(match[2]).trim();

  // For a named place the address starts with its name; for a street address
  // it starts with the street and number. Either is the right thing to call it.
  const name = address.split(",")[0].trim() || address;

  return { googleId: match[1], name, address, lat, lng };
}

async function fetchEmbed(text, timeoutMs) {
  // The `pb` protobuf-ish parameter: `!1m2!2m1!1s<query>`, spaces as `+`.
  const pb = `!1m2!2m1!1s${encodeURIComponent(text).replace(/%20/g, "+")}`;
  const url = `${EMBED_URL}?origin=mfe&pb=${pb}&hl=id`;

  const response = await fetchWithTimeout(url, {
    timeoutMs,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "id,en"
    }
  });

  if (!response.ok) {
    throw new Error(`google-maps/embed responded ${response.status}`);
  }

  return parseEmbedPayload(await response.text());
}

function toSuggestion(place) {
  return {
    name: place.name,
    displayName: place.address,
    lat: place.lat,
    lng: place.lng,
    osmId: "",
    osmType: "",
    category: "",
    type: "",
    categoryId: "other",
    source: "google-maps",
    googleId: place.googleId
  };
}

/**
 * Resolve text to a single exact suggestion, or null when Google has nothing
 * for it either. Throws only when the request itself failed.
 */
export async function resolveViaGoogleMaps(text, { timeoutMs = 8000 } = {}) {
  if (!ENABLED) {
    return null;
  }

  const trimmed = String(text || "").trim();

  if (trimmed.length < 2) {
    return null;
  }

  const key = cacheKey(trimmed);
  const store = getStore();

  let cached = null;

  try {
    cached = store.getGeocode(key);
  } catch (error) {
    console.warn(`[google-maps] cache read failed: ${error.message}`);
  }

  if (cached) {
    const age = Date.now() - cached.updatedAt;
    const ttl = cached.payload ? HIT_TTL_MS : MISS_TTL_MS;

    if (age < ttl) {
      return cached.payload ? toSuggestion(cached.payload) : null;
    }
  }

  const place = await schedule(() => fetchEmbed(trimmed, timeoutMs));

  // Google answers what it thinks you meant. For text it cannot place that is
  // usually nothing, but not always - so the result still has to share an
  // identifying token with the query before it is offered as the answer.
  const accepted =
    place && filterByRelevance([toSuggestion(place)], trimmed).length ? place : null;

  try {
    store.saveGeocode(key, accepted);
  } catch (error) {
    console.warn(`[google-maps] cache write failed: ${error.message}`);
  }

  return accepted ? toSuggestion(accepted) : null;
}

/** Text that names a house number - something OSM does not carry here, and
 * the strongest signal that only Google will have the exact spot. */
export function looksLikeStreetAddress(text) {
  return /\b(no\.?|nomor)\s*\d+[a-z]?\b/i.test(String(text || ""));
}
