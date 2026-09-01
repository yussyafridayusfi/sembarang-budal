import express from "express";
import { getStore } from "../lib/db.js";
import { searchPlaces } from "../lib/sources/nominatim.js";
import { haversineDistanceMeters, toNumber } from "../lib/geo.js";

const router = express.Router();

const COUNTRY_CODES = process.env.PLACES_COUNTRY_CODES || "";
const MAX_LOCATIONS = 12;

/**
 * Saved routes live in the database rather than a module-level variable.
 *
 * The previous in-memory array silently lost data on every deploy and, on
 * serverless, between the POST and the GET that follows it - each invocation
 * gets a fresh process, so a saved route was gone by the time the page reloaded.
 *
 * The route id comes from the client (stored in its own localStorage), so two
 * browsers do not overwrite each other.
 */
function routeIdFor(req) {
  const raw = String(req.get("x-route-id") || req.query.routeId || "default").trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : "default";
}

function normalizeIncoming(entry) {
  if (typeof entry === "string") {
    return { name: entry.trim(), lat: null, lng: null };
  }

  if (entry && typeof entry === "object") {
    return {
      name: String(entry.name || entry.displayName || "").trim(),
      displayName: String(entry.displayName || entry.name || "").trim(),
      lat: toNumber(entry.lat),
      lng: toNumber(entry.lng)
    };
  }

  return { name: "", lat: null, lng: null };
}

/**
 * Resolve a location to coordinates. When the client already picked a
 * suggestion it sends the coordinates along, and we keep them - re-geocoding
 * the display string, as the old code did, wasted a request and could resolve
 * to a different place than the one the user clicked.
 */
async function resolveLocation(entry) {
  if (entry.lat !== null && entry.lng !== null) {
    return {
      name: entry.name || `${entry.lat.toFixed(5)}, ${entry.lng.toFixed(5)}`,
      displayName: entry.displayName || entry.name,
      lat: entry.lat,
      lng: entry.lng,
      resolvedBy: "client"
    };
  }

  if (!entry.name) {
    throw new Error("A location needs either text or coordinates.");
  }

  const results = await searchPlaces(entry.name, {
    limit: 5,
    countryCodes: COUNTRY_CODES,
    timeoutMs: 8000
  });

  const best = results
    .map((item) => ({ item, lat: Number(item.lat), lng: Number(item.lon) }))
    .filter(({ lat, lng }) => Number.isFinite(lat) && Number.isFinite(lng))
    .sort((a, b) => Number(b.item.importance || 0) - Number(a.item.importance || 0))[0];

  if (!best) {
    throw new Error(`Could not find "${entry.name}". Try adding a city or picking a suggestion.`);
  }

  return {
    name: entry.name,
    displayName: best.item.display_name || entry.name,
    lat: best.lat,
    lng: best.lng,
    resolvedBy: "geocoder"
  };
}

function centroidOf(locations) {
  if (!locations.length) {
    return null;
  }

  const total = locations.reduce(
    (accumulator, location) => ({
      lat: accumulator.lat + location.lat,
      lng: accumulator.lng + location.lng
    }),
    { lat: 0, lng: 0 }
  );

  return {
    lat: total.lat / locations.length,
    lng: total.lng / locations.length
  };
}

/**
 * How far the centroid sits from the furthest member. Used to suggest a search
 * radius that actually reaches everyone rather than a fixed 1/3/5 km.
 */
function suggestedRadius(locations, center) {
  if (!center || locations.length < 2) {
    return 2000;
  }

  const furthest = Math.max(
    ...locations.map((location) => haversineDistanceMeters(center.lat, center.lng, location.lat, location.lng))
  );

  return Math.max(500, Math.min(30000, Math.round((furthest * 0.6) / 100) * 100));
}

function buildPayload(locations) {
  const center = centroidOf(locations);

  return {
    locations,
    center,
    suggestedRadius: suggestedRadius(locations, center),
    updatedAt: Date.now()
  };
}

router.get("/locations", (req, res) => {
  const payload = getStore().getRoute(routeIdFor(req));

  if (!payload) {
    return res.json({ locations: [], center: null, suggestedRadius: 2000 });
  }

  return res.json(payload);
});

router.post("/locations", async (req, res) => {
  const incoming = req.body?.locations;

  if (!Array.isArray(incoming)) {
    return res.status(400).json({ error: "locations must be an array." });
  }

  const normalized = incoming
    .map(normalizeIncoming)
    .filter((entry) => entry.name || (entry.lat !== null && entry.lng !== null))
    .slice(0, MAX_LOCATIONS);

  if (!normalized.length) {
    return res.status(400).json({ error: "Please provide at least one location." });
  }

  const resolved = [];
  const failed = [];

  for (const entry of normalized) {
    try {
      resolved.push(await resolveLocation(entry));
    } catch (error) {
      failed.push({ input: entry.name, reason: error.message });
    }
  }

  if (!resolved.length) {
    return res.status(422).json({
      error: failed[0]?.reason || "None of the locations could be resolved.",
      failed
    });
  }

  const payload = buildPayload(resolved);
  getStore().saveRoute(routeIdFor(req), payload);

  // Partial success is reported rather than swallowed: the user sees which of
  // their inputs did not resolve instead of a route that quietly lost a stop.
  return res.status(201).json({ ...payload, failed });
});

router.delete("/locations", (req, res) => {
  getStore().saveRoute(routeIdFor(req), buildPayload([]));
  return res.json({ locations: [], center: null, suggestedRadius: 2000 });
});

export default router;
