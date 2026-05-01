import express from "express";
import { getLocations, setLocations } from "../store/locations.js";

const router = express.Router();

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

export default router;
