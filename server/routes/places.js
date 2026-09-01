import express from "express";
import { discoverPlaces, storeStats } from "../lib/discovery.js";
import { publicCategories, resolveCategoryIds, describeTags } from "../lib/categories.js";
import { buildPlaceDetails } from "../lib/placeDetails.js";
import { clamp, toNumber } from "../lib/geo.js";
import { reverseGeocode, searchPlaces } from "../lib/sources/nominatim.js";

const router = express.Router();

/** Free-form radius, matching how a maps app works, but bounded so a single
 * request cannot ask for an area we could never cover. */
const MIN_RADIUS = 200;
const MAX_RADIUS = 30000;

/** Optional country restriction. Empty by default - the previous hard-coded
 * Indonesia-only filter rejected valid searches with a confusing error. */
const COUNTRY_CODES = process.env.PLACES_COUNTRY_CODES || "";

router.get("/categories", (req, res) => {
  res.json({ categories: publicCategories() });
});

router.get("/stats", (req, res) => {
  res.json(storeStats());
});

/**
 * Location autocomplete.
 *
 * Deliberately does NOT filter by OSM class. The old implementation kept only
 * an allowlist of classes, which silently dropped every city, district and
 * village (those are `boundary=administrative`) - typing "Surabaya" returned
 * zero suggestions.
 */
router.get("/search", async (req, res) => {
  const query = String(req.query.query || "").trim();

  if (query.length < 2) {
    return res.json({ suggestions: [] });
  }

  try {
    const results = await searchPlaces(query, {
      limit: 20,
      countryCodes: COUNTRY_CODES,
      timeoutMs: 8000
    });

    const suggestions = results
      .map((item) => {
        const lat = Number(item.lat);
        const lng = Number(item.lon);

        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          return null;
        }

        const tagKey = item.category || item.class || "";
        const tagValue = item.type || "";

        return {
          name: item.name || item.display_name?.split(",")[0] || query,
          displayName: item.display_name || "",
          lat,
          lng,
          osmId: item.osm_id || "",
          osmType: item.osm_type || "",
          category: tagKey,
          type: tagValue,
          categoryId: describeTags({ [tagKey]: tagValue })?.categoryId || "other",
          importance: Number(item.importance || 0)
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 12);

    return res.json({ suggestions });
  } catch (error) {
    return res.status(502).json({ error: `Address lookup is unavailable right now (${error.message}).` });
  }
});

/** Turn a coordinate into a label - used for "use my location" and map clicks. */
router.get("/reverse", async (req, res) => {
  const lat = toNumber(req.query.lat);
  const lng = toNumber(req.query.lng);

  if (lat === null || lng === null) {
    return res.status(400).json({ error: "lat and lng are required numeric values." });
  }

  try {
    const result = await reverseGeocode(lat, lng, { timeoutMs: 8000 });

    return res.json({
      lat,
      lng,
      name: result?.name || result?.display_name?.split(",")[0] || "Selected point",
      displayName: result?.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`
    });
  } catch (error) {
    // A failed label must not block the search - the coordinate is what matters.
    return res.json({
      lat,
      lng,
      name: "Selected point",
      displayName: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      warning: error.message
    });
  }
});

/**
 * The core endpoint: everything to go to within `radius` of a point.
 */
router.get("/places/nearby", async (req, res) => {
  const lat = toNumber(req.query.lat);
  const lng = toNumber(req.query.lng);
  const requestedRadius = toNumber(req.query.radius);

  if (lat === null || lng === null) {
    return res.status(400).json({ error: "lat and lng are required numeric values." });
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: "lat must be within -90..90 and lng within -180..180." });
  }

  const radius = clamp(requestedRadius === null ? 2000 : requestedRadius, MIN_RADIUS, MAX_RADIUS);
  const categoryIds = resolveCategoryIds(req.query.categories);
  const limit = clamp(toNumber(req.query.limit) ?? 200, 1, 500);

  try {
    const result = await discoverPlaces({
      lat,
      lng,
      radius,
      categoryIds,
      query: String(req.query.q || ""),
      limit,
      refresh: String(req.query.refresh || "") === "1"
    });

    return res.json(result);
  } catch (error) {
    return res.status(502).json({ error: error.message || "Failed to search for places." });
  }
});

/**
 * Backwards-compatible aliases for the previous endpoints, which only accepted
 * radii of exactly 1000/3000/5000.
 */
router.get("/places/center", (req, res) => {
  const params = new URLSearchParams({
    lat: String(req.query.lat || ""),
    lng: String(req.query.lng || ""),
    radius: String(req.query.radius || 2000),
    categories: String(req.query.categories || "")
  });

  res.redirect(307, `/api/places/nearby?${params.toString()}`);
});

router.get("/places/middle", (req, res) => {
  const params = new URLSearchParams({
    lat: String(req.query.lat || ""),
    lng: String(req.query.lng || ""),
    radius: String(req.query.radius || 2000),
    categories: String(req.query.categories || "")
  });

  res.redirect(307, `/api/places/nearby?${params.toString()}`);
});

router.get("/place/details", async (req, res) => {
  const lat = toNumber(req.query.lat);
  const lng = toNumber(req.query.lng);
  const id = String(req.query.id || "").trim();

  if (!id && (lat === null || lng === null)) {
    return res.status(400).json({ error: "Either id, or lat and lng, are required." });
  }

  try {
    const detail = await buildPlaceDetails({
      id,
      lat,
      lng,
      name: String(req.query.name || "").trim(),
      type: String(req.query.type || "").trim()
    });

    return res.json(detail);
  } catch (error) {
    return res.status(502).json({ error: error.message || "Failed to load place details." });
  }
});

export default router;
