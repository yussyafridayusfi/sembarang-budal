import express from "express";
import { getLocations, setLocations } from "../store/locations.js";

const router = express.Router();

const ALLOWED_RADII = new Set([1000, 3000, 5000]);
const placeDetailCache = new Map();

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

function hashString(input) {
  return Array.from(input).reduce((hash, character) => {
    return (hash * 31 + character.charCodeAt(0)) >>> 0;
  }, 7);
}

function buildMockReviews(name, type) {
  return [
    `Good ${type} with tasty food and cozy atmosphere at ${name}.`,
    `${name} is cheap and clean, but service can be slow during busy hours.`,
    `Many visitors say ${name} has friendly staff and a comfortable place to meet.`,
    `Some people mention slow service, but the food is good and affordable.`
  ];
}

function analyzeSentiment(reviews) {
  const positiveKeywords = ["good", "tasty", "cheap", "cozy", "friendly", "comfortable", "affordable", "clean"];
  const negativeKeywords = ["bad", "slow", "expensive", "crowded", "noisy", "dirty"];

  let positiveHits = 0;
  let negativeHits = 0;

  reviews.forEach((review) => {
    const text = review.toLowerCase();
    positiveKeywords.forEach((keyword) => {
      if (text.includes(keyword)) {
        positiveHits += 1;
      }
    });
    negativeKeywords.forEach((keyword) => {
      if (text.includes(keyword)) {
        negativeHits += 1;
      }
    });
  });

  const totalHits = positiveHits + negativeHits || 1;
  const positiveScore = positiveHits / totalHits;
  const negativeScore = negativeHits / totalHits;

  let sentiment = "neutral";
  if (positiveScore > 0.6) {
    sentiment = "positive";
  } else if (negativeScore > 0.5) {
    sentiment = "negative";
  }

  return {
    sentiment,
    score: Number(positiveScore.toFixed(2)),
    summary:
      positiveScore >= negativeScore
        ? "Most visitors like the atmosphere and value, though a few mention slower service at busy times."
        : "Visitors mention some downsides in service or comfort, but there are still positive comments about the place."
  };
}

function estimatePriceRange(tags = {}) {
  const source = `${tags.price_range || ""} ${tags.cuisine || ""} ${tags.amenity || ""}`.toLowerCase();

  if (source.includes("coffee") || source.includes("cafe") || source.includes("fast_food") || source.includes("warung")) {
    return "$";
  }

  if (source.includes("steak") || source.includes("seafood") || source.includes("sushi")) {
    return "$$$";
  }

  return "$$";
}

function buildGoogleMapsLink(lat, lng, name) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name} ${lat},${lng}`)}`;
}

function normalizePlaceFromOverpass(item, centerLat, centerLng) {
  const itemLat = Number(item.lat ?? item.center?.lat);
  const itemLng = Number(item.lon ?? item.center?.lon);

  if (!Number.isFinite(itemLat) || !Number.isFinite(itemLng)) {
    return null;
  }

  const type = item.tags?.amenity || "place";
  const name = item.tags?.name || item.tags?.brand || type;

  return {
    id: `${item.type}-${item.id}`,
    osmId: item.id,
    osmType: item.type,
    name,
    lat: itemLat,
    lng: itemLng,
    type,
    tags: item.tags || {},
    distance: Math.round(haversineDistanceMeters(centerLat, centerLng, itemLat, itemLng))
  };
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

async function handleCenterPlacesRequest(req, res) {
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
        return normalizePlaceFromOverpass(item, lat, lng);
      })
      .filter(Boolean)
      .sort((a, b) => a.distance - b.distance);

    return res.json({
      center: { lat, lng },
      radius,
      places
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to search meeting places." });
  }
}

router.get("/places/center", handleCenterPlacesRequest);
router.get("/places/middle", handleCenterPlacesRequest);

router.get("/place/details", async (req, res) => {
  const lat = toNumber(req.query.lat);
  const lng = toNumber(req.query.lng);
  const osmId = String(req.query.osmId || "").trim();
  const osmType = String(req.query.osmType || "").trim();
  const name = String(req.query.name || "Place").trim();

  if (lat === null || lng === null) {
    return res.status(400).json({ error: "lat and lng are required numeric values." });
  }

  const cacheKey = `${osmType}-${osmId}-${lat}-${lng}`;
  if (placeDetailCache.has(cacheKey)) {
    return res.json(placeDetailCache.get(cacheKey));
  }

  try {
    const reviews = buildMockReviews(name, req.query.type || "place");
    const sentiment = analyzeSentiment(reviews);
    const seed = hashString(cacheKey);
    const rating = Number((3.8 + (seed % 12) / 10).toFixed(1));
    const reviewCount = 20 + (seed % 180);
    const detail = {
      id: cacheKey,
      name,
      address: `Lat ${lat.toFixed(5)}, Lng ${lng.toFixed(5)}, Indonesia`,
      coordinates: { lat, lng },
      googleMapsUrl: buildGoogleMapsLink(lat, lng, name),
      instagram: seed % 2 === 0 ? `https://instagram.com/${name.toLowerCase().replace(/[^a-z0-9]+/g, "")}` : "",
      website: seed % 3 === 0 ? `https://${name.toLowerCase().replace(/[^a-z0-9]+/g, "")}.example.com` : "",
      phone: seed % 4 === 0 ? `+62 21 ${String(100000 + (seed % 900000)).padStart(6, "0")}` : "",
      rating,
      reviewCount,
      priceRange: estimatePriceRange({ amenity: req.query.type }),
      exampleMenu: ["Signature coffee", "Rice bowl", "Snack platter"],
      sentiment,
      reviews,
      tags: {
        amenity: req.query.type || "place"
      }
    };

    placeDetailCache.set(cacheKey, detail);
    return res.json(detail);
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to load place details." });
  }
});

export default router;
