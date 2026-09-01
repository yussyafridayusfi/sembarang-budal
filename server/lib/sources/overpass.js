import { fetchJson, HttpError, mapWithConcurrency } from "../http.js";
import { categoryIdForTag, getCategory } from "../categories.js";

/**
 * Overpass is the only free source that can return *every* POI inside a radius,
 * so it is the primary source. It is also the flakiest: the public instances
 * answer 429 when more than ~2 queries run concurrently per IP, and 504 when a
 * single query is too broad.
 *
 * Two rules follow, and both were violated by the previous implementation:
 *  1. Keep each query small - one category group at a time, never an unbounded
 *     `["shop"]` over a 5 km radius.
 *  2. Rotate mirrors and demote ones that just failed.
 */
const MIRRORS = (process.env.OVERPASS_ENDPOINTS ||
  [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter"
  ].join(","))
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

/** Mirrors that recently failed are tried last rather than dropped forever. */
const mirrorPenalty = new Map();
const PENALTY_MS = 60_000;

function orderedMirrors() {
  const now = Date.now();

  return [...MIRRORS].sort((a, b) => {
    const penaltyA = (mirrorPenalty.get(a) || 0) > now ? 1 : 0;
    const penaltyB = (mirrorPenalty.get(b) || 0) > now ? 1 : 0;
    return penaltyA - penaltyB;
  });
}

function penalise(mirror) {
  mirrorPenalty.set(mirror, Date.now() + PENALTY_MS);
}

function buildCategoryQuery(category, lat, lng, radius, timeoutSeconds, maxResults) {
  const statements = category.tags
    .map(([key, values]) => {
      const pattern = values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
      return `  nwr["${key}"~"^(${pattern})$"](around:${radius},${lat},${lng});`;
    })
    .join("\n");

  return `[out:json][timeout:${timeoutSeconds}];\n(\n${statements}\n);\nout center tags ${maxResults};`;
}

async function runQuery(query, deadline, maxPerMirrorMs) {
  let lastError = new HttpError(503, "No Overpass mirror configured");

  for (const mirror of orderedMirrors()) {
    // Recomputed per mirror: without this, four mirrors x one timeout each
    // overruns the shared request budget several times over.
    const timeoutMs = deadline.budget(maxPerMirrorMs);

    if (timeoutMs < 2000) {
      throw lastError;
    }

    try {
      const data = await fetchJson(mirror, {
        method: "POST",
        timeoutMs,
        label: mirror,
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ data: query })
      });

      if (!Array.isArray(data.elements)) {
        // A mirror answering 200 without an `elements` array is misconfigured;
        // treating it as "zero places found" is how empty results used to be
        // reported as success.
        throw new HttpError(502, `${mirror} returned no elements array`);
      }

      return data.elements;
    } catch (error) {
      lastError = error;
      penalise(mirror);
    }
  }

  throw lastError;
}

export function buildAddress(tags = {}) {
  const parts = [
    [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" ").trim(),
    tags["addr:village"] || tags["addr:suburb"],
    tags["addr:city"] || tags["addr:town"] || tags["addr:district"],
    tags["addr:state"],
    tags["addr:postcode"]
  ];

  return parts.filter(Boolean).join(", ");
}

const POI_TAG_KEYS = [
  "amenity",
  "shop",
  "tourism",
  "leisure",
  "historic",
  "natural",
  "public_transport",
  "railway",
  "aeroway"
];

function normalizeElement(element) {
  const lat = Number(element.lat ?? element.center?.lat);
  const lng = Number(element.lon ?? element.center?.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  const tags = element.tags || {};
  const name = tags.name || tags["name:id"] || tags["name:en"] || tags.brand || tags.operator;

  // Unnamed nodes are noise when you are picking somewhere to go.
  if (!name) {
    return null;
  }

  let tagKey = null;
  let tagValue = null;

  for (const key of POI_TAG_KEYS) {
    if (tags[key]) {
      tagKey = key;
      tagValue = String(tags[key]);
      break;
    }
  }

  if (!tagKey) {
    return null;
  }

  return {
    id: `${element.type}/${element.id}`,
    osmType: element.type,
    osmId: element.id,
    name: String(name),
    lat,
    lng,
    categoryId: categoryIdForTag(tagKey, tagValue),
    tagKey,
    tagValue,
    tags,
    address: buildAddress(tags),
    source: "overpass"
  };
}

/**
 * Fetch places for the given categories around a point. Categories are queried
 * one at a time with concurrency 2 (Overpass's per-IP slot limit); a category
 * that fails does not sink the others.
 */
export async function fetchOverpassPlaces({
  lat,
  lng,
  radius,
  categoryIds,
  deadline,
  maxResults = 400,
  maxPerMirrorMs = 15_000
}) {
  const categories = categoryIds.map(getCategory).filter(Boolean);
  const places = [];
  const failures = [];
  const coveredCategoryIds = [];

  await mapWithConcurrency(categories, 2, async (category) => {
    const budget = deadline.budget(maxPerMirrorMs);

    if (budget < 2500) {
      failures.push({ category: category.id, reason: "deadline reached" });
      return;
    }

    const timeoutSeconds = Math.max(5, Math.floor(budget / 1000) - 1);
    const query = buildCategoryQuery(category, lat, lng, radius, timeoutSeconds, maxResults);

    try {
      const elements = await runQuery(query, deadline, maxPerMirrorMs);
      elements.forEach((element) => {
        const place = normalizeElement(element);
        if (place) {
          places.push(place);
        }
      });

      // Overpass answers a whole category in one query, so a success here means
      // this category is fully scraped for the area - including a genuine zero.
      coveredCategoryIds.push(category.id);
    } catch (error) {
      failures.push({ category: category.id, reason: error.message });
    }
  });

  return { places, failures, coveredCategoryIds };
}
