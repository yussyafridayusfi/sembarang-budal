/**
 * Turning what someone types into something a geocoder will actually match.
 *
 * Both Nominatim and Photon are effectively all-or-nothing on a free-text
 * query: a single token they cannot place drops the result count to zero rather
 * than degrading to a coarser match. Indonesian addresses are written in a way
 * that trips this constantly - abbreviations, a house number, an RT/RW block -
 * and they run specific-to-general, so the tokens most likely to fail are at
 * the front.
 *
 * Measured against Nominatim, "jl tumapel no 34 ketajen gedangan":
 *
 *   jl tumapel no 34 ketajen gedangan   0 results
 *   jalan tumapel ketajen gedangan      0 results
 *   tumapel ketajen gedangan            0 results
 *   ketajen gedangan                    1 result   <- Ketajen, Gedangan, Sidoarjo
 *
 * So the street is simply not in OSM here, and there is nothing to be done
 * about that - but the village two tokens later is, and answering with it beats
 * answering with nothing.
 */

/** Common Indonesian address abbreviations, expanded to what OSM tends to hold. */
const ABBREVIATIONS = new Map([
  ["jl", "jalan"],
  ["jln", "jalan"],
  ["ji", "jalan"],
  ["gg", "gang"],
  ["kec", "kecamatan"],
  ["kel", "kelurahan"],
  ["kab", "kabupaten"],
  ["kab.", "kabupaten"],
  ["prov", "provinsi"],
  ["kp", "kampung"],
  ["ds", "desa"],
  ["perum", "perumahan"],
  ["komp", "kompleks"],
  ["gd", "gedung"]
]);

/**
 * House numbers, RT/RW blocks and postcodes. OSM rarely carries house-level
 * data in Indonesia, so these tokens can only ever cost us a match.
 */
const NOISE_PATTERNS = [
  /\bno\.?\s*\d+[a-z]?\b/gi,
  /\bnomor\s*\d+[a-z]?\b/gi,
  /\brt\.?\s*\d+\s*\/?\s*rw\.?\s*\d+\b/gi,
  /\brt\.?\s*\d+\b/gi,
  /\brw\.?\s*\d+\b/gi,
  /\bblok\s+[a-z0-9]+\b/gi,
  /\b\d{5}\b/g
];

function tidy(text) {
  return text.replace(/[,]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Expand abbreviations and drop the tokens a geocoder cannot use. */
export function normalizeAddressQuery(raw) {
  let text = String(raw || "").toLowerCase();

  NOISE_PATTERNS.forEach((pattern) => {
    text = text.replace(pattern, " ");
  });

  const expanded = tidy(text)
    .split(" ")
    .map((token) => {
      const bare = token.replace(/\.$/, "");
      return ABBREVIATIONS.get(bare) || token;
    })
    .filter(Boolean);

  return tidy(expanded.join(" "));
}

/**
 * Progressively coarser versions of a query, most specific first, deduplicated.
 *
 * Callers try them in order and stop at the first that returns anything, so a
 * query that already works costs exactly one request and only a failing one
 * pays for the fallbacks. Trailing tokens are kept in preference to leading
 * ones because an Indonesian address ends with the administrative area, which
 * is the part OSM reliably holds.
 */
export function buildQueryVariants(raw, { maxVariants = 4, dropTokens = true } = {}) {
  const original = tidy(String(raw || ""));

  if (!original) {
    return [];
  }

  const variants = [original];
  const normalized = normalizeAddressQuery(original);

  if (normalized && normalized !== original.toLowerCase()) {
    variants.push(normalized);
  }

  // Dropping leading tokens is right for an address, where the tail is the
  // administrative area, and wrong for a proper name, where the head *is* the
  // name: "MPM Learning Center - Sidoarjo" relaxed to "Center - Sidoarjo"
  // matched an unrelated "Merpati Maintenance Center" and presented it as the
  // answer. Callers resolving a business name pass `dropTokens: false`.
  if (dropTokens) {
    // Two tokens is the floor: a single token like "gedangan" matches dozens of
    // unrelated villages nationwide, which is not a useful answer.
    const tokens = (normalized || original).split(" ").filter(Boolean);

    for (let start = 1; start <= tokens.length - 2; start += 1) {
      variants.push(tokens.slice(start).join(" "));
    }
  }

  return Array.from(new Set(variants.filter(Boolean))).slice(0, maxVariants);
}

/**
 * Words that carry no identifying power in a place name, so a result matching
 * only these is not a match at all. Kept deliberately short: the goal is to find
 * the *distinctive* part of a query, not to build a stopword corpus.
 */
const GENERIC_NAME_WORDS = new Set([
  "the", "and", "of", "at", "in", "dan", "di", "ke",
  "learning", "center", "centre", "centro",
  "school", "sekolah", "kampus", "college", "university", "universitas",
  "plaza", "mall", "store", "shop", "toko", "market", "pasar",
  "hotel", "resort", "cafe", "coffee", "resto", "restaurant", "warung",
  "rumah", "sakit", "hospital", "clinic", "klinik", "apotek",
  "park", "taman", "masjid", "gereja", "kantor", "office",
  "place", "tempat", "area", "point", "city", "town", "village",
  "no", "jalan", "gang", "kecamatan", "kelurahan", "kabupaten", "kota", "desa"
]);

function nameTokens(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u00c0-\u024f\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The tokens that actually identify a place - "MPM" and "Sidoarjo" out of
 * "MPM Learning Center - Sidoarjo".
 */
export function distinctiveTokens(query) {
  return nameTokens(query).filter(
    // A bare number is a house number or a postcode, not an identity: requiring
    // "101" to appear would reject every OSM row for an address OSM only holds
    // at street level.
    (token) => token.length > 1 && !/^\d+$/.test(token) && !GENERIC_NAME_WORDS.has(token)
  );
}

/**
 * Drop results that share no identifying token with the query.
 *
 * Photon matches fuzzily, and for a name it does not hold it will happily
 * return a semantic near-miss on the other side of the world: asked for
 * "MPM Learning Center - Sidoarjo" it answered "Smart Start Learning Center"
 * in Nukus, Uzbekistan, then Lae in Papua New Guinea, then Bhopal. Every one
 * matched on "learning center" alone and none contained "MPM" or "Sidoarjo".
 *
 * Presenting those as candidates is worse than returning nothing - the user is
 * invited to pick a pin thousands of kilometres from where they meant. A result
 * must contain at least one distinctive token from the query, matched against
 * its name and address together so a place named for its street still passes.
 *
 * When the query is entirely generic there is nothing to discriminate on, and
 * the results are returned untouched rather than filtered arbitrarily.
 */
export function filterByRelevance(results, query) {
  const wanted = distinctiveTokens(query);

  if (!wanted.length) {
    return results;
  }

  // With one or two distinctive tokens, all of them; with three or more, a
  // majority. "Any one" was too loose: "zzzqqwwx nonsense" kept "No Nonsense
  // Fitness" in Edinburgh on the strength of "nonsense", and "MPM Learning
  // Center Sidoarjo" kept "XL Center ... Sidoarjo" on "sidoarjo" alone - which
  // then read as a real match and stopped the exact Google resolution from ever
  // being tried. A majority from three up leaves room for the one token OSM
  // lacks: "tumapel ketajen gedangan" still accepts "Jalan Raya Ketajen,
  // Gedangan", because Tumapel is the street OSM does not have.
  const needed = wanted.length <= 2 ? wanted.length : Math.ceil(wanted.length / 2);

  return results.filter((result) => {
    const haystack = new Set(nameTokens(`${result.name || ""} ${result.displayName || ""}`));
    const matched = wanted.filter((token) => haystack.has(token)).length;
    return matched >= needed;
  });
}

/**
 * Google share names are often "Place Name - Area". When the place itself
 * cannot be found, the area still locates it roughly, which for choosing a
 * meeting point is far more use than nothing - provided it is labelled as the
 * approximation it is.
 */
export function splitNameAndArea(name) {
  const match = String(name || "").match(/^(.*?)\s+[-\u2013\u2014]\s+(.+)$/);

  if (!match) {
    return { place: tidy(String(name || "")), area: "" };
  }

  return { place: tidy(match[1]), area: tidy(match[2]) };
}

/**
 * A raw coordinate pair typed or pasted into a location box.
 *
 * This is the free, exact escape hatch for a place no geocoder holds: in Google
 * Maps, right-click the spot and the first menu item copies "-7.389, 112.728".
 * No API key, no lookup, no ambiguity - and it is the only way to pin a place
 * that exists in Google's index but not in OpenStreetMap's.
 *
 * Anchored to the whole input on purpose. Matching a pair *inside* a longer
 * string would take the "16 18" out of "Jalan Achmad Yani 16-18" and drop a pin
 * off the coast of Africa.
 */
export function parseLatLngText(raw) {
  const match = String(raw || "")
    .trim()
    .match(/^\(?\s*(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*\)?$/);

  if (!match) {
    return null;
  }

  const lat = Number(match[1]);
  const lng = Number(match[2]);

  // Require a decimal somewhere: two bare integers are far more likely to be a
  // house number or a date than a position anyone meant to paste.
  if (!/\./.test(match[1]) && !/\./.test(match[2])) {
    return null;
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180 || (lat === 0 && lng === 0)) {
    return null;
  }

  return { lat, lng };
}
