import { fetchJsonWithRetry, mapWithConcurrency } from "../http.js";
import { categoryIdForTag, osmTagsForCategory } from "../categories.js";
import { boundingBox, boxCenter, haversineDistanceMeters, splitBoundingBox } from "../geo.js";

/**
 * Photon (the Komoot geocoder built on OSM) is the request-path browse source.
 *
 * It replaces Nominatim there because of throughput, which is what made whole
 * categories come back empty. Nominatim's `[key=value]` special-phrase search
 * needs one request per tag *value*, and its usage policy allows one request
 * per second, so a twelve-category search is 40+ serialised requests - roughly
 * 45 s against a 14 s budget. Photon filters by `osm_tag=<key>`, so the same
 * search is nine requests, and it tolerates them being made concurrently.
 *
 * Nominatim is still used for reverse geocoding and as the autocomplete
 * fallback.
 */
const BASE_URL = process.env.PHOTON_URL || "https://photon.komoot.io";

/**
 * Photon caps every response at 50 features regardless of `limit`. A capped
 * tile means "there are more here that you did not see", so it must never be
 * recorded as covered - that is how an area gets cached as complete when most
 * of it was never returned.
 */
const RESULT_CAP = 50;

/**
 * Photon has no published per-IP rate limit and answers this many in parallel
 * answers this many in parallel without complaint, but it is a free public
 * instance and it does defend itself: eight at a time drew HTTP 503s, and
 * sustained bursts earned a connection-level block. Keep this modest, and see
 * LIVE_FETCH_COOLDOWN_MS in discovery.js for the other half of being a good
 * citizen here.
 */
const CONCURRENCY = Number(process.env.PHOTON_CONCURRENCY || 4);

/**
 * `lang=id` is rejected outright by Photon ("Supported are: default, de, en,
 * fr") and fails the whole request. `default` is what we want anyway: it
 * returns local names, so Indonesian places keep their Indonesian names.
 */
const LANG = "default";

function osmTypeName(code) {
  if (code === "W") return "way";
  if (code === "R") return "relation";
  return "node";
}

/** Photon spreads the address over flat properties rather than an object. */
function buildPhotonAddress(props) {
  return [
    props.street && props.housenumber ? `${props.street} ${props.housenumber}` : props.street,
    props.district,
    props.city || props.town || props.village,
    props.county,
    props.state,
    props.postcode,
    props.country
  ]
    .filter(Boolean)
    .join(", ");
}

function normalizeFeature(feature, allowedCategoryIds) {
  const props = feature?.properties || {};
  const coords = feature?.geometry?.coordinates;

  if (!Array.isArray(coords) || coords.length < 2) {
    return null;
  }

  const lng = Number(coords[0]);
  const lat = Number(coords[1]);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  const tagKey = props.osm_key;
  const tagValue = props.osm_value;
  const name = props.name;

  if (!tagKey || !tagValue || !name) {
    return null;
  }

  const categoryId = categoryIdForTag(tagKey, tagValue);

  // Browsing by key returns everything under it, including values the taxonomy
  // does not use (amenity=bench, amenity=waste_basket). Those are dropped here
  // rather than shown as an unlabelled "other".
  if (!allowedCategoryIds.has(categoryId)) {
    return null;
  }

  const osmType = osmTypeName(props.osm_type);
  const osmId = props.osm_id;

  return {
    // Same id scheme as the other sources so they dedupe against each other.
    id: osmId ? `${osmType}/${osmId}` : `photon/${lat.toFixed(6)},${lng.toFixed(6)}`,
    osmType,
    osmId,
    name: String(name),
    lat,
    lng,
    categoryId,
    tagKey,
    tagValue,
    tags: { [tagKey]: tagValue },
    address: buildPhotonAddress(props),
    source: "photon"
  };
}

/** A tile is a box plus the sub-circle that covers it, since Photon browses by
 * centre and radius but subdivision is easier to reason about as a box. */
function tileForBox(box) {
  const center = boxCenter(box);
  // Reach the box's corner, so neighbouring sub-circles overlap rather than
  // leaving unsearched gaps between them.
  const cornerMeters = haversineDistanceMeters(center.lat, center.lng, box.maxLat, box.maxLng);

  return { box, lat: center.lat, lng: center.lng, radiusKm: Math.max(cornerMeters, 200) / 1000 };
}

/**
 * How many times a capped tile may be split into quarters. Four rounds turns a
 * 30 km circle into 256 cells, which is far past the point where a cell still
 * caps in practice.
 */
const MAX_TILE_DEPTH = 4;

async function fetchTile({ tile, osmTags, allowedCategoryIds, timeoutMs }) {
  const params = new URLSearchParams({
    lat: String(tile.lat),
    lon: String(tile.lng),
    radius: tile.radiusKm.toFixed(3),
    limit: String(RESULT_CAP),
    lang: LANG
  });

  osmTags.forEach((tag) => params.append("osm_tag", tag));

  // Retry a 429/503 - Photon returns them under load and answers on the next
  // try - but never a timeout. These run against a shared request deadline, and
  // re-running a request that already spent its whole timeout takes budget the
  // other categories need; an uncovered category is retried on the next search.
  const data = await fetchJsonWithRetry(`${BASE_URL}/reverse?${params.toString()}`, {
    attempts: 2,
    backoffMs: 400,
    retryTimeouts: false,
    timeoutMs,
    label: "photon/reverse"
  });

  const features = Array.isArray(data?.features) ? data.features : null;

  // A body with no `features` array is a failure, not an empty area. Treating
  // the two as the same is how a broken upstream reads as "nothing here".
  if (!features) {
    throw new Error("photon/reverse returned no features array");
  }

  return {
    places: features.map((feature) => normalizeFeature(feature, allowedCategoryIds)).filter(Boolean),
    capped: features.length >= RESULT_CAP
  };
}

/**
 * Browse an area for the requested categories.
 *
 * One request per category, not per OSM key. Photon accepts a list of
 * `osm_tag=key:value` filters, so a category asks for exactly its own tags and
 * gets its own 50-result slot. Browsing by bare key instead let the dense keys
 * bury the sparse categories: `osm_tag=amenity` covers seven of our categories
 * at once, and its nearest 50 results in an Indonesian suburb are schools and
 * mosques, so bars and cinemas were pushed out of every response and read as
 * "there are none here".
 *
 * Tiling is adaptive on top of that: a category that comes back at the cap is
 * split into quarters and asked again, and one that does not is left alone. A
 * fixed grid spent the whole budget re-asking sparse categories about empty
 * corners - a 3 km search was 36 requests of which only 15 finished.
 *
 * Returns partial results plus `coveredCategoryIds`, which lists only the
 * categories that completed *and* bottomed out under the cap. Anything less is
 * left uncovered, so the next search retries it instead of answering it as
 * empty from the cache.
 */
export async function fetchPhotonPlaces({ lat, lng, radius, categoryIds, deadline }) {
  const allowedCategoryIds = new Set(categoryIds);
  const rootTile = tileForBox(boundingBox(lat, lng, radius));

  const places = [];
  const failures = [];
  /** Categories that returned everything they had, everywhere we looked. */
  const cleanCategories = new Set(categoryIds);
  let capped = 0;
  let completed = 0;
  let requests = 0;

  let wave = categoryIds
    .map((categoryId) => {
      const osmTags = osmTagsForCategory(categoryId);

      if (!osmTags.length) {
        cleanCategories.delete(categoryId);
        return null;
      }

      return { categoryId, osmTags, tile: rootTile, depth: 0 };
    })
    .filter(Boolean);

  while (wave.length) {
    const next = [];

    await mapWithConcurrency(wave, CONCURRENCY, async (job) => {
      const budget = deadline.budget(7000);

      if (budget < 1200) {
        cleanCategories.delete(job.categoryId);
        return null;
      }

      requests += 1;

      try {
        const result = await fetchTile({
          tile: job.tile,
          osmTags: job.osmTags,
          allowedCategoryIds,
          timeoutMs: budget
        });

        places.push(...result.places);
        completed += 1;

        if (!result.capped) {
          return null;
        }

        capped += 1;

        // Capped means there is more here than we were shown. Split and look
        // again; if we have run out of depth, the category is not clean.
        if (job.depth >= MAX_TILE_DEPTH) {
          cleanCategories.delete(job.categoryId);
          return null;
        }

        splitBoundingBox(job.tile.box, 2, 2).forEach((cell) => {
          next.push({ ...job, tile: tileForBox(cell), depth: job.depth + 1 });
        });
      } catch (error) {
        failures.push({ tag: job.categoryId, reason: error.message });
        cleanCategories.delete(job.categoryId);
      }

      return null;
    });

    if (deadline.remaining() < 1200) {
      // Whatever was still queued never ran, so those categories are not clean.
      next.forEach((job) => cleanCategories.delete(job.categoryId));
      break;
    }

    wave = next;
  }

  const coveredCategoryIds = categoryIds.filter((categoryId) => cleanCategories.has(categoryId));

  return { places, failures, capped, completed, requests, coveredCategoryIds };
}

/**
 * Free-text lookup for the location autocomplete. Photon has no rate-limit
 * queue in front of it, so this answers while the user is still typing.
 *
 * Photon has no country filter parameter, so `countryCodes` is applied to the
 * results here.
 */
export async function searchPhoton(
  query,
  { limit = 15, countryCodes = "", timeoutMs = 6000, viewbox = null, near = null } = {}
) {
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
    lang: LANG
  });

  // Soft bias, not a filter: a bare name off a shared link ("Royal Plaza") has
  // matches on several continents, and the one near the user is almost always
  // the one they meant.
  if (near) {
    params.set("lat", String(near.lat));
    params.set("lon", String(near.lng));
  }

  if (viewbox) {
    // Photon's bbox is minLon,minLat,maxLon,maxLat - the opposite corner order
    // to Nominatim's viewbox, which is why this is not shared between them.
    params.set(
      "bbox",
      `${viewbox.minLng},${viewbox.minLat},${viewbox.maxLng},${viewbox.maxLat}`
    );
  }

  const allowedCountries = countryCodes
    .split(",")
    .map((code) => code.trim().toLowerCase())
    .filter(Boolean);

  const data = await fetchJsonWithRetry(`${BASE_URL}/api?${params.toString()}`, {
    attempts: 2,
    timeoutMs,
    label: "photon/search"
  });

  const features = Array.isArray(data?.features) ? data.features : null;

  if (!features) {
    throw new Error("photon/search returned no features array");
  }

  return features
    .map((feature) => {
      const props = feature?.properties || {};
      const coords = feature?.geometry?.coordinates;

      if (!Array.isArray(coords) || coords.length < 2) {
        return null;
      }

      const lng = Number(coords[0]);
      const lat = Number(coords[1]);

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return null;
      }

      const countryCode = String(props.countrycode || "").toLowerCase();

      if (allowedCountries.length && !allowedCountries.includes(countryCode)) {
        return null;
      }

      const tagKey = props.osm_key || "";
      const tagValue = props.osm_value || "";
      const address = buildPhotonAddress(props);
      const name = props.name || address.split(",")[0] || query;

      return {
        name: String(name),
        displayName: address ? `${name}, ${address}` : String(name),
        lat,
        lng,
        osmId: props.osm_id || "",
        osmType: osmTypeName(props.osm_type),
        category: tagKey,
        type: tagValue,
        categoryId: categoryIdForTag(tagKey, tagValue),
        countryCode,
        source: "photon"
      };
    })
    .filter(Boolean);
}
