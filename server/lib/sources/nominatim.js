import { fetchJsonWithRetry, sleep } from "../http.js";
import { categoryIdForTag, getCategory } from "../categories.js";
import { buildAddress } from "./overpass.js";

/**
 * Nominatim turned out to be the most dependable free browse source: a bounded
 * `viewbox` search with the `[key=value]` special-phrase syntax answers in
 * ~1-2s and returns only that category, whereas Overpass frequently 504s.
 *
 * The trade-off is a hard 50-result cap per query and a strict 1 request per
 * second usage policy, so every call goes through one shared queue and large
 * areas are split into tiles instead of asked for in one shot.
 */
const BASE_URL = process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org";
const MIN_INTERVAL_MS = Number(process.env.NOMINATIM_MIN_INTERVAL_MS || 1100);
const RESULT_CAP = 50;

let queueTail = Promise.resolve();
let lastRequestAt = 0;

/** Serialises every Nominatim call and spaces them out to honour the policy. */
function schedule(task) {
  const run = queueTail.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);

    if (wait > 0) {
      await sleep(wait);
    }

    lastRequestAt = Date.now();
    return task();
  });

  // Keep the chain alive even when a task rejects.
  queueTail = run.then(
    () => undefined,
    () => undefined
  );

  return run;
}

function viewboxParam(box) {
  return `${box.minLng},${box.maxLat},${box.maxLng},${box.minLat}`;
}

function normalizeResult(item) {
  const lat = Number(item.lat);
  const lng = Number(item.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  const tagKey = item.category || item.class;
  const tagValue = item.type;

  if (!tagKey || !tagValue) {
    return null;
  }

  const name = item.name || item.display_name?.split(",")[0];

  if (!name) {
    return null;
  }

  const osmType = String(item.osm_type || "node");
  const osmId = item.osm_id;

  return {
    // Same id scheme as Overpass so the two sources dedupe against each other.
    id: osmId ? `${osmType}/${osmId}` : `nominatim/${lat.toFixed(6)},${lng.toFixed(6)}`,
    osmType,
    osmId,
    name: String(name),
    lat,
    lng,
    categoryId: categoryIdForTag(tagKey, tagValue),
    tagKey,
    tagValue,
    // Only the real OSM tag. Address parts live in `address`; mixing them in
    // here made sparse Nominatim places look fully tagged to the detail view.
    tags: { [tagKey]: tagValue },
    address: item.display_name || buildAddress(item.address || {}),
    source: "nominatim"
  };
}

async function searchTagInBox({ tagKey, tagValue, box, timeoutMs }) {
  const params = new URLSearchParams({
    format: "jsonv2",
    q: `[${tagKey}=${tagValue}]`,
    viewbox: viewboxParam(box),
    bounded: "1",
    limit: String(RESULT_CAP),
    addressdetails: "1",
    "accept-language": "id,en"
  });

  const data = await schedule(() =>
    fetchJsonWithRetry(`${BASE_URL}/search?${params.toString()}`, {
      attempts: 2,
      timeoutMs,
      label: "nominatim/search"
    })
  );

  const items = Array.isArray(data) ? data : [];

  return {
    places: items.map(normalizeResult).filter(Boolean),
    capped: items.length >= RESULT_CAP
  };
}

/**
 * Free-text place lookup used by the location autocomplete.
 * `countrycodes` is applied only when a country filter is configured, so the
 * app is not silently limited to one country.
 */
export async function searchPlaces(
  query,
  { limit = 15, countryCodes = "", timeoutMs = 8000, viewbox = null, bounded = true } = {}
) {
  const params = new URLSearchParams({
    format: "jsonv2",
    q: query,
    limit: String(limit),
    addressdetails: "1",
    "accept-language": "id,en"
  });

  if (countryCodes) {
    params.set("countrycodes", countryCodes);
  }

  if (viewbox) {
    params.set("viewbox", viewboxParam(viewbox));

    if (bounded) {
      params.set("bounded", "1");
    }
  }

  const data = await schedule(() =>
    fetchJsonWithRetry(`${BASE_URL}/search?${params.toString()}`, {
      attempts: 2,
      timeoutMs,
      label: "nominatim/search"
    })
  );

  return Array.isArray(data) ? data : [];
}

export async function reverseGeocode(lat, lng, { timeoutMs = 8000 } = {}) {
  const params = new URLSearchParams({
    format: "jsonv2",
    lat: String(lat),
    lon: String(lng),
    addressdetails: "1",
    "accept-language": "id,en"
  });

  return schedule(() =>
    fetchJsonWithRetry(`${BASE_URL}/reverse?${params.toString()}`, {
      attempts: 2,
      timeoutMs,
      label: "nominatim/reverse"
    })
  );
}

/**
 * Build the work list for an area: one job per (category tag value, tile).
 *
 * Jobs are emitted breadth-first by tag rank so that a budget which only
 * covers part of the list still returns something from *every* selected
 * category - depth in one category at the expense of the others reads as
 * "nothing found" for the rest. Tiles defeat the 50-result cap.
 */
export function planTagJobs(categoryIds, tiles, { maxTagsPerCategory = Infinity } = {}) {
  const perCategory = categoryIds
    .map((categoryId) => {
      const category = getCategory(categoryId);

      if (!category) {
        return null;
      }

      const flattened = [];
      category.tags.forEach(([tagKey, values]) => {
        values.forEach((tagValue) => flattened.push({ categoryId, tagKey, tagValue }));
      });

      // On the request path only the defining tags are queried, so every
      // selected category finishes inside the budget and can be marked as
      // covered. The long tail is filled in by the background ingest and by
      // scripts/ingest.js.
      return flattened.slice(0, maxTagsPerCategory);
    })
    .filter(Boolean);

  const jobs = [];
  const deepest = Math.max(0, ...perCategory.map((list) => list.length));

  for (let rank = 0; rank < deepest; rank += 1) {
    perCategory.forEach((list) => {
      const tag = list[rank];

      if (!tag) {
        return;
      }

      tiles.forEach((tile, tileIndex) => {
        jobs.push({ ...tag, rank, tileIndex, box: tile });
      });
    });
  }

  return jobs;
}

/**
 * Run as many tag/tile jobs as fit inside the deadline. Returns partial results
 * plus the jobs that were not reached, so the caller can finish them in the
 * background and warm the cache for next time.
 */
export async function fetchNominatimPlaces({ jobs, deadline }) {
  const places = [];
  const failures = [];
  const pending = [];
  let capped = 0;

  // Per-category outcome, so the caller can record coverage only for the
  // categories it actually finished querying. Marking a category as covered
  // because *some other* category succeeded is how a search silently returned
  // zero results for it from then on.
  const outcome = new Map();

  const track = (categoryId, field) => {
    if (!outcome.has(categoryId)) {
      outcome.set(categoryId, { ok: 0, failed: 0, pending: 0 });
    }

    outcome.get(categoryId)[field] += 1;
  };

  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    const budget = deadline.budget(9000);

    // Each job needs its rate-limit slot plus the request itself.
    if (budget < MIN_INTERVAL_MS + 1500) {
      jobs.slice(index).forEach((remaining) => {
        pending.push(remaining);
        track(remaining.categoryId, "pending");
      });
      break;
    }

    try {
      const result = await searchTagInBox({ ...job, timeoutMs: budget - MIN_INTERVAL_MS });
      places.push(...result.places);
      track(job.categoryId, "ok");

      if (result.capped) {
        capped += 1;
      }
    } catch (error) {
      failures.push({ tag: `${job.tagKey}=${job.tagValue}`, reason: error.message });
      track(job.categoryId, "failed");
    }
  }

  const coveredCategoryIds = Array.from(outcome.entries())
    .filter(([, counts]) => counts.ok > 0 && counts.failed === 0 && counts.pending === 0)
    .map(([categoryId]) => categoryId);

  return { places, failures, pending, capped, coveredCategoryIds };
}
