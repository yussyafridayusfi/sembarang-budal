import { getStore } from "./db.js";
import { boundingBox, haversineDistanceMeters, splitBoundingBox, tileKeysForBox } from "./geo.js";
import { createDeadline } from "./http.js";
import { fetchOverpassPlaces } from "./sources/overpass.js";
import { fetchNominatimPlaces, planTagJobs } from "./sources/nominatim.js";
import { fetchPhotonPlaces, searchPhoton } from "./sources/photon.js";

/**
 * How long a cached area stays trusted before we re-scrape it. POI data moves
 * slowly; a week keeps the app fast without going stale in a way anyone notices.
 */
const COVERAGE_MAX_AGE_MS = Number(process.env.COVERAGE_MAX_AGE_MS || 7 * 24 * 60 * 60 * 1000);

/** Fraction of tiles that must be fresh before we skip the live fetch. */
const COVERAGE_THRESHOLD = 0.85;

/**
 * How long an area rests after a live fetch before it may be fetched again.
 *
 * Coverage does not always reach the threshold: a category that genuinely caps
 * everywhere, or an upstream having a bad day, leaves it short for as long as
 * that lasts. Without this, such an area re-fetched on *every single request* -
 * a dozen upstream calls per page load, which is both pointless (the results
 * were already cached and identical) and the fastest way to get the app blocked
 * by a free public API. Verified: it got us a connection-level block from
 * photon.komoot.io inside a few minutes.
 */
const LIVE_FETCH_COOLDOWN_MS = Number(process.env.LIVE_FETCH_COOLDOWN_MS || 10 * 60 * 1000);

/** areaKey -> last live fetch. Per process, which is the right scope: it exists
 * to stop one instance hammering an upstream, not to be a shared truth. */
const lastLiveFetchAt = new Map();

function noteLiveFetch(areaKey) {
  // Bound the map so a long-running instance browsing many areas cannot grow it
  // without limit.
  if (lastLiveFetchAt.size > 500) {
    lastLiveFetchAt.clear();
  }

  lastLiveFetchAt.set(areaKey, Date.now());
}

function isCoolingDown(areaKey) {
  const last = lastLiveFetchAt.get(areaKey);
  return Boolean(last) && Date.now() - last < LIVE_FETCH_COOLDOWN_MS;
}

const IS_SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

/** Background top-up is only useful where the process outlives the response. */
const BACKGROUND_ENABLED = process.env.DISABLE_BACKGROUND_INGEST !== "1" && !IS_SERVERLESS;

const backgroundInFlight = new Set();

function tilesForRadius(box, radius) {
  if (radius <= 2000) {
    return [box];
  }

  if (radius <= 6000) {
    return splitBoundingBox(box, 2, 2);
  }

  if (radius <= 15000) {
    return splitBoundingBox(box, 3, 3);
  }

  return splitBoundingBox(box, 4, 4);
}

/**
 * Merge places from several sources. Overpass carries full OSM tags, so it wins
 * on conflicts; otherwise the entry with an address wins, because that is what
 * the detail panel shows.
 */
function mergePlaces(groups) {
  const merged = new Map();

  groups.flat().forEach((place) => {
    if (!place) {
      return;
    }

    const existing = merged.get(place.id);

    if (!existing) {
      merged.set(place.id, place);
      return;
    }

    const incomingWins =
      (place.source === "overpass" && existing.source !== "overpass") ||
      (Object.keys(place.tags || {}).length > Object.keys(existing.tags || {}).length);

    merged.set(place.id, {
      ...(incomingWins ? place : existing),
      address: existing.address || place.address || "",
      tags: { ...(existing.tags || {}), ...(place.tags || {}) }
    });
  });

  return Array.from(merged.values());
}

function withinRadius(places, lat, lng, radius) {
  return places
    .map((place) => ({
      ...place,
      distance: Math.round(haversineDistanceMeters(lat, lng, place.lat, place.lng))
    }))
    .filter((place) => place.distance <= radius);
}

function matchesQuery(place, needle) {
  if (!needle) {
    return true;
  }

  const haystack = `${place.name} ${place.tagValue || ""} ${place.address || ""}`.toLowerCase();
  return haystack.includes(needle);
}

function persist(places) {
  if (!places.length) {
    return;
  }

  try {
    getStore().upsertPlaces(places);
  } catch (error) {
    console.warn(`[discovery] failed to persist places: ${error.message}`);
  }
}

function markCovered(tileKeys, categoryIds) {
  try {
    getStore().markCoverage(tileKeys, categoryIds);
  } catch (error) {
    console.warn(`[discovery] failed to mark coverage: ${error.message}`);
  }
}

/**
 * Finish the tag/tile jobs that did not fit in the request budget, so the next
 * search over the same area is served entirely from the database.
 */
function scheduleBackgroundIngest({ lat, lng, radius, categoryIds, areaKey }) {
  if (!BACKGROUND_ENABLED || backgroundInFlight.has(areaKey)) {
    return false;
  }

  backgroundInFlight.add(areaKey);

  const timer = setTimeout(async () => {
    const deadline = createDeadline(Number(process.env.BACKGROUND_BUDGET_MS || 120_000));
    const box = boundingBox(lat, lng, radius);
    const tiles = tilesForRadius(box, radius);

    try {
      const overpass = await fetchOverpassPlaces({
        lat,
        lng,
        radius,
        categoryIds,
        deadline
      });
      persist(overpass.places);

      const nominatim = await fetchNominatimPlaces({
        jobs: planTagJobs(categoryIds, tiles),
        deadline
      });
      persist(nominatim.places);

      const covered = Array.from(
        new Set([...(overpass.coveredCategoryIds || []), ...(nominatim.coveredCategoryIds || [])])
      );

      if (covered.length) {
        markCovered(tileKeysForBox(box), covered);
      }
      console.log(
        `[discovery] background ingest for ${areaKey}: +${overpass.places.length} overpass, +${nominatim.places.length} nominatim`
      );
    } catch (error) {
      console.warn(`[discovery] background ingest failed for ${areaKey}: ${error.message}`);
    } finally {
      backgroundInFlight.delete(areaKey);
    }
  }, 50);

  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return true;
}

/**
 * Extra bounded free-text pass, used when the user typed something specific.
 * Runs on Photon so it does not queue behind the browse requests - on
 * Nominatim it shared the one-request-per-second queue and usually never ran.
 */
async function fetchTextMatches(query, box, deadline) {
  if (!query || deadline.remaining() < 2500) {
    return [];
  }

  try {
    const results = await searchPhoton(query, {
      limit: 50,
      timeoutMs: deadline.budget(5000),
      viewbox: box
    });

    return results.map((item) => ({
      id: item.osmId ? `${item.osmType}/${item.osmId}` : `photon/${item.lat.toFixed(6)},${item.lng.toFixed(6)}`,
      osmType: item.osmType,
      osmId: item.osmId,
      name: item.name,
      lat: item.lat,
      lng: item.lng,
      categoryId: item.categoryId,
      tagKey: item.category,
      tagValue: item.type,
      tags: item.category && item.type ? { [item.category]: item.type } : {},
      address: item.displayName || "",
      source: "photon-text"
    }));
  } catch (error) {
    console.warn(`[discovery] text search failed: ${error.message}`);
    return [];
  }
}

/**
 * The main entry point: everything within `radius` of a point, in the requested
 * categories.
 *
 * Order of operations is deliberate. The database is answered first so a warm
 * area returns instantly and keeps working while the free upstream APIs are
 * rate-limiting. Only a cold or stale area pays for a live fetch, and that
 * fetch runs under a shared deadline so a hung upstream degrades the result
 * instead of failing the request.
 */
export async function discoverPlaces({
  lat,
  lng,
  radius,
  categoryIds,
  query = "",
  limit = 200,
  refresh = false,
  budgetMs = Number(process.env.DISCOVERY_BUDGET_MS || 14000)
}) {
  const store = getStore();
  const box = boundingBox(lat, lng, radius);
  const tileKeys = tileKeysForBox(box);
  const needle = query.trim().toLowerCase();

  const cached = store.findPlacesInBox(box, categoryIds, 4000);
  const coverage = store.coverageRatio(tileKeys, categoryIds, COVERAGE_MAX_AGE_MS);
  const areaKey = `${lat.toFixed(3)},${lng.toFixed(3)}/${radius}/${categoryIds.join("+")}`;

  const diagnostics = {
    cachedCount: cached.length,
    coverage: Number(coverage.toFixed(2)),
    liveFetch: false,
    sources: [],
    failures: [],
    backgroundQueued: false
  };

  let places = cached;

  // An explicit refresh always fetches. Otherwise a thin area is fetched unless
  // it was just fetched and we already have something to show for it.
  const cooling = isCoolingDown(areaKey);
  const needsLiveFetch = refresh || (coverage < COVERAGE_THRESHOLD && !(cooling && cached.length));

  diagnostics.cooling = cooling;

  if (needsLiveFetch) {
    diagnostics.liveFetch = true;
    noteLiveFetch(areaKey);
    const deadline = createDeadline(budgetMs);

    // Photon only on the request path: one request per category, answered
    // concurrently, so all twelve fit in the budget. Nominatim needed one
    // rate-limited request per tag *value* - 40+ serialised requests against a
    // 14 s budget - so it only ever reached a handful, which is why most
    // categories came back empty. Overpass is richer still but measured 13s+
    // per category and often 504s. Both now run in the background ingest
    // instead, where slowness is free.
    const [photonResult, textResult] = await Promise.all([
      fetchPhotonPlaces({ lat, lng, radius, categoryIds, deadline }).catch((error) => ({
        places: [],
        failures: [{ tag: "photon", reason: error.message }],
        capped: 0,
        completed: 0,
        requests: 0,
        coveredCategoryIds: []
      })),
      fetchTextMatches(needle, box, deadline)
    ]);

    const live = mergePlaces([photonResult.places, textResult]);

    if (photonResult.places.length) {
      diagnostics.sources.push({ source: "photon", count: photonResult.places.length });
    }

    if (textResult.length) {
      diagnostics.sources.push({ source: "photon-text", count: textResult.length });
    }

    diagnostics.failures = photonResult.failures || [];
    diagnostics.cappedTiles = photonResult.capped || 0;
    diagnostics.completedJobs = `${photonResult.completed}/${photonResult.requests}`;

    let covered = photonResult.coveredCategoryIds || [];

    // If Photon gave us nothing at all and failed doing it, it is down, blocked
    // or rate-limiting us. Fall back to Nominatim for whatever budget is left:
    // it is far slower (one rate-limited request per tag value, so only a few
    // categories will fit) but it keeps the app returning real places instead
    // of an empty list while the primary source is unavailable.
    if (!photonResult.places.length && photonResult.failures.length && deadline.remaining() > 3000) {
      const fallback = await fetchNominatimPlaces({
        jobs: planTagJobs(categoryIds, [box], { maxTagsPerCategory: 1 }),
        deadline
      }).catch((error) => ({ places: [], failures: [{ tag: "nominatim", reason: error.message }], coveredCategoryIds: [] }));

      if (fallback.places.length) {
        diagnostics.sources.push({ source: "nominatim-fallback", count: fallback.places.length });
        live.push(...fallback.places);
      }

      diagnostics.failures = [...diagnostics.failures, ...(fallback.failures || [])];

      // Only one tag per category is queried here, so this cannot honestly
      // claim a category is fully covered - leave coverage to Photon and the
      // background ingest.
      covered = [];
    }

    persist(live);

    // Coverage is recorded per category, and only for categories whose queries
    // actually completed. Marking the whole request as covered because *any*
    // category returned data made later searches for the untouched categories
    // answer 0 from cache forever.

    if (covered.length) {
      markCovered(tileKeys, covered);
    }

    diagnostics.coveredCategories = covered;

    places = mergePlaces([cached, live]);

    diagnostics.backgroundQueued = scheduleBackgroundIngest({
      lat,
      lng,
      radius,
      categoryIds,
      areaKey
    });
  }

  const ranked = withinRadius(places, lat, lng, radius)
    .filter((place) => matchesQuery(place, needle))
    .sort((a, b) => a.distance - b.distance);

  diagnostics.totalInRadius = ranked.length;

  return {
    center: { lat, lng },
    radius,
    categoryIds,
    places: ranked.slice(0, limit),
    truncated: ranked.length > limit,
    diagnostics
  };
}

export function storeStats() {
  return getStore().stats();
}
