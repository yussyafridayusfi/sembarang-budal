import express from "express";
import { getLocations, setLocations } from "../store/locations.js";

const router = express.Router();

const ALLOWED_RADII = new Set([1000, 3000, 5000]);

async function searchNominatim(query, limit = 1) {
  const params = new URLSearchParams({
    format: "json",
    addressdetails: "1",
    limit: String(limit),
    q: query,
    countrycodes: "id",
    "accept-language": "id"
  });

  const endpoint = `https://nominatim.openstreetmap.org/search?${params.toString()}`;

  const response = await fetch(endpoint, {
    headers: {
      "User-Agent": "sembarang-budal/1.0 (learning-project)"
    }
  });

  if (!response.ok) {
    throw new Error(`Geocoding service failed for: ${query}`);
  }

  return response.json();
}

function isIndonesianResult(item) {
  return String(item?.address?.country_code || "").toLowerCase() === "id";
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function haversineDistanceMeters(lat1, lng1, lat2, lng2) {
  const earthRadius = 6371000;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function geocodeLocation(query) {
  const results = (await searchNominatim(query, 5)).filter(isIndonesianResult);

  if (!results.length) {
    throw new Error(`Only Indonesian addresses are allowed: ${query}`);
  }

  return {
    name: query,
    displayName: results[0].display_name,
    lat: Number(results[0].lat),
    lng: Number(results[0].lon)
  };
}

router.get("/locations", (req, res) => {
  res.json({ locations: getLocations() });
});

router.get("/search", async (req, res) => {
  const query = String(req.query.query || "").trim();

  if (query.length < 2) {
    return res.json({ suggestions: [] });
  }

  try {
    const results = (await searchNominatim(query, 5)).filter(isIndonesianResult);

    return res.json({
      suggestions: results.map((item) => ({
        name: item.name || query,
        displayName: item.display_name,
        lat: Number(item.lat),
        lng: Number(item.lon)
      }))
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to search locations." });
  }
});

router.post("/locations", async (req, res) => {
  const { locations } = req.body;

  if (!Array.isArray(locations)) {
    return res.status(400).json({ error: "locations must be an array of text values." });
  }

  const normalized = locations
    .map((item) => String(item || "").trim())
    .filter(Boolean);

  if (normalized.length < 2) {
    return res.status(400).json({ error: "Please provide at least 2 locations." });
  }

  try {
    const geocoded = [];

    for (const locationName of normalized) {
      const result = await geocodeLocation(locationName);
      geocoded.push(result);
    }

    setLocations(geocoded);

    return res.status(201).json({
      message: "Locations saved successfully.",
      locations: geocoded
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to save locations." });
  }
});

router.get("/places/middle", async (req, res) => {
  const lat = toNumber(req.query.lat);
  const lng = toNumber(req.query.lng);
  const radius = toNumber(req.query.radius);

  if (lat === null || lng === null || radius === null) {
    return res.status(400).json({ error: "lat, lng, and radius are required numeric values." });
  }

  if (!ALLOWED_RADII.has(radius)) {
    return res.status(400).json({ error: "radius must be one of 1000, 3000, or 5000." });
  }

  const query = `
    [out:json][timeout:25];
    (
      node["amenity"~"cafe|restaurant|fast_food"](around:${radius},${lat},${lng});
      way["amenity"~"cafe|restaurant|fast_food"](around:${radius},${lat},${lng});
      relation["amenity"~"cafe|restaurant|fast_food"](around:${radius},${lat},${lng});
    );
    out center tags;
  `;

  try {
    const response = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": "sembarang-budal/1.0 (learning-project)"
      },
      body: new URLSearchParams({ data: query.trim() })
    });

    if (!response.ok) {
      throw new Error("Overpass API request failed.");
    }

    const data = await response.json();
    const places = (data.elements || [])
      .map((item) => {
        const itemLat = Number(item.lat ?? item.center?.lat);
        const itemLng = Number(item.lon ?? item.center?.lon);

        if (!Number.isFinite(itemLat) || !Number.isFinite(itemLng)) {
          return null;
        }

        const type = item.tags?.amenity || "place";
        const name = item.tags?.name || item.tags?.brand || type;

        return {
          name,
          lat: itemLat,
          lng: itemLng,
          type,
          distance: Math.round(haversineDistanceMeters(lat, lng, itemLat, itemLng))
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.distance - b.distance);

    return res.json({
      midpoint: { lat, lng },
      radius,
      places
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to search middle places." });
  }
});

export default router;
