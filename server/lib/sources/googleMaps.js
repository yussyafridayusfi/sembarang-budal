import { fetchWithTimeout, sleep } from "../http.js";
import { getStore } from "../db.js";
import { filterByRelevance } from "../addressQuery.js";
import { haversineDistanceMeters } from "../geo.js";

/**
 * Resolve free text to an exact place through Google Maps itself, and read the
 * place card that comes with it.
 *
 * This exists because OpenStreetMap does not hold everything people paste. "MPM
 * Learning Center - Sidoarjo" has no OSM entry; "Jl. Tumapel No.34" is a house
 * number OSM does not carry in Indonesia. Both are one request away in Google
 * Maps, and the person pasting them expects the pin Google would give them.
 *
 * It uses the public embed endpoint - the same request an `<iframe>` embed
 * makes - rather than the full Maps page or the Search page. It is ~3 KB, needs
 * no JavaScript, shows no consent interstitial, and its payload carries the
 * resolved place as a plain array. That array is richer than it first looks:
 * after the id/address/coordinates record come the display name, the address
 * lines, the **rating**, the **review count** ("10.116 ulasan"), the **phone**,
 * the **website**, the category label ("Restoran Mie"), the **Place ID**
 * (`ChIJ…`), a plus code, and the **weekly opening hours** with the current
 * "Buka · Tutup pukul 23.00" status. Measured on Mie Gacoan Puri Surya Jaya and
 * Royal Plaza; the school MPM Learning Center carried everything but a rating.
 *
 * What the payload does *not* carry: photos, price, review text, or Google's
 * structured attributes (parking, payment, crowd). Those exist only in the
 * official Places API, which the Place ID here feeds directly.
 *
 * Be clear about what this is. It is automated access to Google Maps content,
 * which Google's terms restrict, and there is no rate-limit contract - Google
 * can change the payload or block the client at any time without notice. So:
 *
 * - it is one request per *distinct text*, cached in the database afterwards;
 * - live requests are serialised and spaced out;
 * - it never runs on autocomplete keystrokes, only where OSM has come up empty,
 *   where the text carries a house number, or when a place's details are opened;
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

/** Bumped when the parsed shape changes, so older cache rows are re-read. */
const CARD_VERSION = 3;

/**
 * `["0x…:0x…", "<formatted address>", [lat, lng]` - the place record inside
 * the embed payload. The feature id is a pair of hex values; the address is a
 * JSON string literal, so escaped characters are allowed inside it.
 */
const PLACE_RECORD = /\["(0x[0-9a-f]+:0x[0-9a-f]+)","((?:[^"\\]|\\.)*)",\[(-?\d+\.\d+),(-?\d+\.\d+)\]/;

/** A JSON string literal, with escapes. */
const STR = '"((?:[^"\\\\]|\\\\.)*)"';

/** Plus code: "JP4J+3CH" / "6P4JJQ52+PJ". */
const PLUS_CODE = "[23456789CFGHJMPQRVWX]{4,8}\\+[23456789CFGHJMPQRVWX]{2,3}";

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

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * From `start`, return the bracketed segment that begins there (`[...]`), with
 * nesting honoured and strings skipped, or "" if the value there is `null` or
 * not an array at all.
 */
function balancedSegment(text, start) {
  if (text[start] !== "[") {
    return "";
  }

  let depth = 0;
  let inString = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }

      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;

      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return "";
}

/**
 * The payload is a JavaScript array literal handed to the embed's init call.
 * Locate the place record, then read the fields that follow it by their shape
 * rather than by index - the array is sparse (`null,null,…`) and Google shifts
 * positions between places, but a rating is always a 1-5 float directly
 * followed by a count ending in "ulasan"/"reviews", a Place ID always starts
 * "ChIJ", the category always sits just before the formatted address repeats,
 * and hours are always `["<Day>", <1-7>, [y,m,d], <ranges or null>`.
 */
export function parseEmbedPayload(html) {
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
  const start = match.index + match[0].length;
  // The card for one place is a few KB; stop before the closing script.
  const tail = html.slice(start, start + 8000);

  // Display name: the first string literal after the record closes. Some
  // businesses register with their plus code in front ("JP4J+3CH Mie Gacoan");
  // that is an address, not a name.
  // The record closes with Google's numeric CID (`,"6838982894568862351"]`)
  // before the display name, so the anchor has to step over it.
  const RECORD_END = '^(?:,"\\d+")?\\],';
  const nameMatch = tail.match(new RegExp(`${RECORD_END}${STR}`));
  const rawName = nameMatch ? unescapeJsonString(nameMatch[1]).trim() : address.split(",")[0].trim();
  const name = rawName.replace(new RegExp(`^${PLUS_CODE}\\s+`), "");

  // Address lines: ["Jl. Raya Sedati No.101","Blinjo, Wedi","Kec. Gedangan, …"]
  const linesMatch = tail.match(new RegExp(`${RECORD_END}${STR},(\\[(?:${STR},?)+\\])`));
  const addressLines = linesMatch
    ? [...linesMatch[2].matchAll(new RegExp(STR, "g"))].map((m) => unescapeJsonString(m[1]))
    : [];

  const ratingMatch = tail.match(/,([1-5](?:\.\d+)?),"(\d[\d.,]*)\s*(?:ulasan|reviews?)"/i);
  const rating = ratingMatch ? Math.round(Number(ratingMatch[1]) * 10) / 10 : null;
  // "10.116" is Indonesian for 10,116 - strip every separator.
  const reviewCount = ratingMatch ? Number(ratingMatch[2].replace(/[.,]/g, "")) : null;

  const placeIdMatch = tail.match(/"(ChIJ[\w-]{10,})"/);
  const placeId = placeIdMatch ? placeIdMatch[1] : "";

  const phoneMatch = tail.match(
    /"(\(0\d{1,3}\)\s?[\d\s-]{5,}|\+62[\d\s-]{7,}|0\d{2,3}[\s-]?\d{3,4}[\s-]?\d{3,5})"/
  );
  const phone = phoneMatch ? phoneMatch[1].trim() : "";

  // Website is a small array: ["http://site/","site",…]. Skip Google's own.
  const websiteMatch = tail.match(/\["(https?:\/\/(?!(?:www\.|search\.|maps\.)?google\.)[^"\\]+)","[^"\\]*"/);
  const website = websiteMatch ? websiteMatch[1] : "";

  // Category label ("Restoran Mie", "Pusat Perbelanjaan"): the string right
  // before the formatted address repeats. That repeat begins with the first
  // address line, which is the reliable anchor - the display name is not, as
  // it may carry a plus code or differ from the address entirely.
  let categoryLabel = "";

  if (addressLines[0]) {
    const categoryMatch = tail.match(
      new RegExp(`"([^"\\\\]{3,60})","${escapeRegExp(addressLines[0])}(?:,|")`)
    );

    if (categoryMatch && !/^https?:/.test(categoryMatch[1]) && categoryMatch[1] !== addressLines[0]) {
      categoryLabel = unescapeJsonString(categoryMatch[1]);
    }
  }

  const plusMatch = tail.match(new RegExp(`\\["(${PLUS_CODE})"\\]`));
  const plusCode = plusMatch ? plusMatch[1] : "";

  // Weekly hours: ["Jumat",5,[2026,9,4],[["10.00–23.00",[[10],[23]]]],0,1]
  // A closed day has `null` where the ranges sit. Reading the ranges with a
  // regex over-ran from a closed day into the next day's strings ("Minggu
  // Tutup, Senin, 08.00–17.00"), so each day's ranges are read as one balanced
  // bracket segment instead, and `null` reads as closed.
  const openingHours = [];
  const dayRe = /\["([A-Za-z\u00c0-\u024f]+)",([1-7]),\[\d{4},\d{1,2},\d{1,2}\],/g;
  const seen = new Set();
  let day;

  while ((day = dayRe.exec(tail)) && seen.size < 7) {
    const index = Number(day[2]);

    if (seen.has(index)) {
      continue;
    }

    const segment = balancedSegment(tail, day.index + day[0].length);
    const ranges = segment ? [...segment.matchAll(/"([^"\\]+)"/g)].map((m) => m[1]) : [];

    seen.add(index);
    openingHours.push({
      day: day[1],
      dayIndex: index,
      text: ranges.length ? ranges.join(", ") : "Tutup"
    });
  }

  // Sort Monday-first (Google lists from today).
  openingHours.sort((a, b) => a.dayIndex - b.dayIndex);

  const statusMatch = tail.match(/\["((?:Buka|Tutup|Open|Closed)[^"\\]{0,60})",\[\[/);
  const statusText = statusMatch ? statusMatch[1] : "";
  const openNow = statusText ? /^(Buka|Open)/.test(statusText) : null;

  return {
    version: CARD_VERSION,
    googleId: match[1],
    placeId,
    name,
    address,
    addressLines,
    lat,
    lng,
    rating,
    reviewCount,
    phone,
    website,
    categoryLabel,
    plusCode,
    openingHours,
    openNow,
    statusText
  };
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
    googleId: place.googleId,
    placeId: place.placeId || ""
  };
}

/**
 * The cached place card for a text, fetching it if needed. Returns the full
 * card, or null when Google has nothing for the text, or when what it has does
 * not share an identifying token with the text. Throws only when the request
 * itself failed.
 */
async function resolveCard(text, { timeoutMs = 8000, requireRelevance = true } = {}) {
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
    // Rows written before the card grew its extra fields are re-read once.
    const current = !cached.payload || cached.payload.version === CARD_VERSION;

    if (age < ttl && current) {
      return cached.payload || null;
    }
  }

  const place = await schedule(() => fetchEmbed(trimmed, timeoutMs));

  // Google answers what it thinks you meant. For text it cannot place that is
  // usually nothing, but not always - so the result still has to share an
  // identifying token with the query before it is offered as the answer.
  const accepted =
    place && (!requireRelevance || filterByRelevance([toSuggestion(place)], trimmed).length)
      ? place
      : null;

  try {
    store.saveGeocode(key, accepted);
  } catch (error) {
    console.warn(`[google-maps] cache write failed: ${error.message}`);
  }

  return accepted;
}

/**
 * Resolve text to a single exact suggestion, or null when Google has nothing
 * for it either. Throws only when the request itself failed.
 */
export async function resolveViaGoogleMaps(text, options = {}) {
  const card = await resolveCard(text, options);
  return card ? toSuggestion(card) : null;
}

/**
 * The Google Maps card for a place we already know by name and position.
 *
 * Used when a place's details are opened. The card is only accepted if it lands
 * within `maxDistanceMeters` of where we believe the place is *and* its name
 * shares an identifying token with ours - attaching the wrong Google card to an
 * OSM place would be fabricated data with a real source label on it, which is
 * exactly what bug 11 was about. A miss returns null and the panel says so.
 */
export async function fetchGoogleMapsCard({
  name,
  address = "",
  lat,
  lng,
  maxDistanceMeters = 300,
  timeoutMs = 8000
}) {
  if (!ENABLED || !name) {
    return null;
  }

  // The area disambiguates a common name ("Indomaret"). Address parts that are
  // the name itself or a bare house number are useless as a hint and worse
  // than useless in practice: an OSM address of "Royal Plaza, 16-18, Jalan…"
  // produced the query "Royal Plaza Royal Plaza 16-18", which Google could not
  // place, and the miss was cached for a day.
  const parts = String(address || "")
    .split(",")
    .map((part) => part.trim())
    .filter(
      (part) =>
        part &&
        part.toLowerCase() !== String(name).toLowerCase() &&
        !/^\d+[\d\s–-]*[a-z]?$/i.test(part) &&
        !/^\d{5}$/.test(part) &&
        !/^indonesia$/i.test(part)
    );

  // From most to least specific. The distance guard below is what actually
  // decides; the hint only steers Google towards the right one of several.
  const queries = [
    parts.length ? `${name} ${parts.slice(0, 2).join(" ")}` : "",
    parts.length > 2 ? `${name} ${parts[parts.length - 1]}` : "",
    name
  ].filter((query, index, list) => query && list.indexOf(query) === index);

  for (const query of queries) {
    const card = await resolveCard(query, { timeoutMs, requireRelevance: false });

    if (!card) {
      continue;
    }

    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const distance = haversineDistanceMeters(lat, lng, card.lat, card.lng);

      if (distance > maxDistanceMeters) {
        continue;
      }
    }

    if (!filterByRelevance([{ name: card.name, displayName: card.address }], name).length) {
      continue;
    }

    return card;
  }

  return null;
}

/** Text that names a house number - something OSM does not carry here, and
 * the strongest signal that only Google will have the exact spot. */
export function looksLikeStreetAddress(text) {
  return /\b(no\.?|nomor)\s*\d+[a-z]?\b/i.test(String(text || ""));
}
