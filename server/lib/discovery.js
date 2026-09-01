import { getStore } from "./db.js";
import { boundingBox, haversineDistanceMeters, splitBoundingBox, tileKeysForBox } from "./geo.js";
import { createDeadline } from "./http.js";
import { fetchOverpassPlaces } from "./sources/overpass.js";
import { fetchNominatimPlaces, planTagJobs, searchPlaces } from "./sources/nominatim.js";
import { categoryIdForTag } from "./categories.js";

/**
 * How long a cached area stays trusted before we re-scrape it. POI data moves
 * slowly; a week keeps the app fast without going stale in a way anyone notices.
 */
const COVERAGE_MAX_AGE_MS = Number(process.env.COVERAGE_MAX_AGE_MS || 7 * 24 * 60 * 60 * 1000);

/** Fraction of tiles that must be fresh before we skip the live fetch. */
const COVERAGE_THRESHOLD = 0.85;

/**
 * Tags per category queried on the request path. Two is enough to cover the
 * defining tags (amenity=restaurant/fast_food, shop=mall/department_store) and
 * keeps a five-category search inside the budget.
 */
const FOREGROUND_TAGS_PER_CATEGORY = 2;

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

/** Extra bounded free-text pass, used when the user typed something specific. */
async function fetchTextMatches(query, box, deadline) {
  if (!query || deadline.remaining() < 2500) {
    return [];
  }

  try {
    const results = await searchPlaces(query, {
      limit: 40,
      timeoutMs: deadline.budget(5000),
      viewbox: box
    });

    return results
      .map((item) => {
        const lat = Number(item.lat);
        const lng = Number(item.lon);
        const tagKey = item.category || item.class;
        const tagValue = item.type;
        const name = item.name || item.display_name?.split(",")[0];

        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !tagKey || !tagValue || !name) {
          return null;
        }

        const osmType = String(item.osm_type || "node");

        return {
          id: item.osm_id ? `${osmType}/${item.osm_id}` : `nominatim/${lat.toFixed(6)},${lng.toFixed(6)}`,
          osmType,
          osmId: item.osm_id,
          name: String(name),
          lat,
          lng,
          categoryId: categoryIdForTag(tagKey, tagValue),
          tagKey,
          tagValue,
          tags: { [tagKey]: tagValue },
          address: item.display_name || "",
          source: "nominatim-text"
        };
      })
      .filter(Boolean);
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

  const needsLiveFetch = refresh || coverage < COVERAGE_THRESHOLD;

  if (needsLiveFetch) {
    diagnostics.liveFetch = true;
    const deadline = createDeadline(budgetMs);

    // Nominatim only on the request path. Overpass returns far richer data but
    // measured 13s+ per category against the public mirrors and often 504s, so
    // it would spend the whole budget and contribute nothing; it runs in the
    // background ingest instead, where slowness is free.
    const [nominatimResult, textResult] = await Promise.all([
      fetchNominatimPlaces({
        jobs: planTagJobs(categoryIds, [box], { maxTagsPerCategory: FOREGROUND_TAGS_PER_CATEGORY }),
        deadline
      }).catch((error) => ({
        places: [],
        failures: [{ tag: "nominatim", reason: error.message }],
        pending: [],
        coveredCategoryIds: []
      })),
      fetchTextMatches(needle, box, deadline)
    ]);

    const live = mergePlaces([nominatimResult.places, textResult]);

    if (nominatimResult.places.length) {
      diagnostics.sources.push({ source: "nominatim", count: nominatimResult.places.length });
    }

    if (textResult.length) {
      diagnostics.sources.push({ source: "nominatim-text", count: textResult.length });
    }

    diagnostics.failures = nominatimResult.failures || [];
    diagnostics.pendingJobs = (nominatimResult.pending || []).length;

    persist(live);

    // Coverage is recorded per category, and only for categories whose queries
    // actually completed. Marking the whole request as covered because *any*
    // category returned data made later searches for the untouched categories
    // answer 0 from cache forever.
    const covered = nominatimResult.coveredCategoryIds || [];

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
