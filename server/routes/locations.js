import express from "express";
import { getLocations, setLocations } from "../store/locations.js";

try {
  import("dotenv").then((dotenv) => dotenv.config());
} catch {
  console.log("dotenv not configured, using env vars directly");
}

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

async function reverseGeocode(lat, lng) {
  const params = new URLSearchParams({
    format: "jsonv2",
    lat: String(lat),
    lon: String(lng),
    "accept-language": "id"
  });

  const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params.toString()}`, {
    headers: {
      "User-Agent": "sembarang-budal/1.0 (learning-project)"
    }
  });

  if (!response.ok) {
    throw new Error("Reverse geocoding failed.");
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

function getEnv(key, fallback = "") {
  return process.env[key] || fallback;
}

const GOOGLE_API_KEY = getEnv("GOOGLE_PLACES_API_KEY");

async function fetchGooglePlaceDetails(lat, lng, placeName) {
  if (!GOOGLE_API_KEY) {
    return null;
  }

  try {
    const textSearchUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(placeName + " " + lat + "," + lng)}&location=${lat},${lng}&radius=50&key=${GOOGLE_API_KEY}`;
    const textResponse = await fetch(textSearchUrl, {
      headers: { "User-Agent": "sembarang-budal/1.0" }
    });
    const textData = await textResponse.json();

    if (!textData.results || textData.results.length === 0) {
      return null;
    }

    const place = textData.results[0];
    const placeId = place.place_id;

    const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,formatted_address,geometry,types,rating,user_ratings_total,reviews,website,formatted_phone_number,opening_hours,photos&key=${GOOGLE_API_KEY}`;
    const detailsResponse = await fetch(detailsUrl, {
      headers: { "User-Agent": "sembarang-budal/1.0" }
    });
    const detailsData = await detailsResponse.json();

    if (!detailsData.result) {
      return null;
    }

    let photos = [];
    if (detailsData.result.photos && detailsData.result.photos.length > 0) {
      photos = detailsData.result.photos.slice(0, 5).map((photo, idx) => ({
        url: `https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photo_reference=${photo.photo_reference}&key=${GOOGLE_API_KEY}`,
        alt: `${placeName} photo ${idx + 1}`
      }));
    }

    return { ...detailsData.result, photos };
  } catch (error) {
    console.error("Google Places API error:", error.message);
    return null;
  }
}

function analyzeRealReviews(reviews, placeName = "", placeId = "") {
  if (!reviews || reviews.length === 0) {
    return {
      positive_percentage: 0,
      positive_summary: "No reviews available yet.",
      negative_percentage: 0,
      negative_summary: "No reviews available yet."
    };
  }

  let positiveCount = 0;
  let negativeCount = 0;
  const positivePhrases = ["great", "excellent", "amazing", "wonderful", "fantastic", "love", "good", "best", "delicious", "friendly", "tasty", "fresh", "clean", "recommend", "perfect", "awesome", "nice", "cozy", "comfortable", "affordable", "worth", "helpful", "kind", "fast", "quick", "spacious", "calm", "relaxing", "professional", "happy"];
  const negativePhrases = ["bad", "terrible", "awful", "horrible", "worst", "hate", "disappointed", "slow", "rude", "dirty", "cold", "expensive", "overpriced", "never", "poor", "avoid", "disappointing", "small", "crowded", "noisy", "messy", "broken", "waiting", "long"];

  const extractedPositives = [];
  const extractedNegatives = [];

  reviews.forEach((review) => {
    const text = review.text?.toLowerCase() || "";
    positivePhrases.forEach(phrase => {
      if (text.includes(phrase)) {
        positiveCount++;
        extractedPositives.push(phrase);
      }
    });
    negativePhrases.forEach(phrase => {
      if (text.includes(phrase)) {
        negativeCount++;
        extractedNegatives.push(phrase);
      }
    });
  });

  const total = positiveCount + negativeCount || 1;
  let positivePercentage = Math.round((positiveCount / total) * 100);
  let negativePercentage = Math.round((negativeCount / total) * 100);

  if (positivePercentage === 0 && negativePercentage === 0) {
    positivePercentage = 70;
    negativePercentage = 30;
  }

  // Generate unique AI-like summary based on the specific place and extracted phrases
  const uniquePositives = [...new Set(extractedPositives)].slice(0, 3);
  const uniqueNegatives = [...new Set(extractedNegatives)].slice(0, 2);
  
  const placePrefix = placeName ? `${placeName} is` : "This place is";
  
  let positiveSummary = "";
  if (uniquePositives.length >= 2) {
    positiveSummary = `Most visitors praise the ${uniquePositives.join(" and ")} at this place. Many describe it as a great spot for casual hangouts.`;
  } else if (uniquePositives.length === 1) {
    positiveSummary = `Reviewers frequently mention the ${uniquePositives[0]} aspect of this location. Overall, guests enjoy their experience here.`;
  } else {
    positiveSummary = "The majority of reviews highlight a positive experience. Customers appreciate the overall atmosphere and service quality.";
  }

  let negativeSummary = "";
  if (uniqueNegatives.length >= 2) {
    negativeSummary = `Some concerns were raised about ${uniqueNegatives.join(" and ")}. A few visitors experienced minor issues during their visit.`;
  } else if (uniqueNegatives.length === 1) {
    negativeSummary = `A small number of reviews mention ${uniqueNegatives[0]} as a concern. Most visitors, however, have a pleasant experience.`;
  } else {
    negativeSummary = "Only isolated complaints were found. The general consensus is positive with minimal negative feedback.";
  }

  return {
    positive_percentage: positivePercentage,
    positive_summary: positiveSummary,
    negative_percentage: negativePercentage,
    negative_summary: negativeSummary
  };
}

function buildMockReviews(name, type, seed) {
  const positivePools = {
    cafe: [
      "great coffee and a cozy atmosphere",
      "comfortable seating for chatting or working",
      "friendly staff and nicely presented drinks",
      "affordable menu and calm ambience"
    ],
    restaurant: [
      "tasty food and generous portions",
      "family-friendly atmosphere and quick serving time",
      "good flavors and comfortable seating",
      "worth the price and satisfying menu variety"
    ],
    fast_food: [
      "quick preparation and practical location",
      "affordable menu and consistent taste",
      "easy for casual meetups and takeaway",
      "friendly staff and fast ordering flow"
    ],
    place: [
      "pleasant atmosphere and good overall value",
      "comfortable place to meet and relax",
      "friendly staff and enjoyable experience",
      "clean area and reliable service"
    ]
  };

  const negativePools = {
    cafe: [
      "slow service during busy hours",
      "limited parking space",
      "some drinks take too long to arrive",
      "indoor seating can feel crowded"
    ],
    restaurant: [
      "service can slow down at peak hours",
      "parking is limited on busy days",
      "noise level gets high at lunch and dinner",
      "some dishes are considered a bit expensive"
    ],
    fast_food: [
      "seating area can get crowded quickly",
      "parking is often limited",
      "queues can be long at rush hour",
      "some visitors mention inconsistent service speed"
    ],
    place: [
      "service can be slow when crowded",
      "parking is not always easy",
      "noise level may be high at busy times",
      "some visitors feel the menu is limited"
    ]
  };

  const positives = positivePools[type] || positivePools.place;
  const negatives = negativePools[type] || negativePools.place;

  return Array.from({ length: 6 }, (_, index) => {
    const positive = positives[(seed + index) % positives.length];
    const negative = negatives[(seed + index) % negatives.length];

    if ((seed + index) % 3 === 0) {
      return `Visitors say ${name} has ${positive}, but ${negative}.`;
    }

    if ((seed + index) % 4 === 0) {
      return `Many people like ${name} because of its ${positive}.`;
    }

    return `${name} is known for ${positive}, although ${negative}.`;
  });
}

function analyzeReviewMix(reviews) {
  const positiveKeywords = {
    taste: ["tasty", "flavors", "drinks", "coffee", "food"],
    atmosphere: ["cozy", "calm", "comfortable", "atmosphere", "ambience"],
    value: ["affordable", "value", "worth", "generous"],
    service: ["friendly", "quick", "fast", "reliable"]
  };
  const negativeKeywords = {
    service: ["slow", "queue", "long"],
    parking: ["parking", "limited"],
    crowd: ["crowded", "noise", "busy"],
    price: ["expensive"]
  };

  let positiveHits = 0;
  let negativeHits = 0;
  const positiveTopics = new Map();
  const negativeTopics = new Map();

  reviews.forEach((review) => {
    const text = review.toLowerCase();

    Object.entries(positiveKeywords).forEach(([topic, keywords]) => {
      if (keywords.some((keyword) => text.includes(keyword))) {
        positiveHits += 1;
        positiveTopics.set(topic, (positiveTopics.get(topic) || 0) + 1);
      }
    });

    Object.entries(negativeKeywords).forEach(([topic, keywords]) => {
      if (keywords.some((keyword) => text.includes(keyword))) {
        negativeHits += 1;
        negativeTopics.set(topic, (negativeTopics.get(topic) || 0) + 1);
      }
    });
  });

  const totalHits = positiveHits + negativeHits || 1;
  let positivePercentage = Math.round((positiveHits / totalHits) * 100);
  let negativePercentage = Math.round((negativeHits / totalHits) * 100);

  if (positivePercentage === negativePercentage) {
    positivePercentage += 1;
    negativePercentage = Math.max(0, 100 - positivePercentage);
  }

  const topPositiveTopics = [...positiveTopics.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([topic]) => topic);
  const topNegativeTopics = [...negativeTopics.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([topic]) => topic);

  const positiveSummary = topPositiveTopics.length
    ? `People often praise the ${topPositiveTopics.join(", ")}.`
    : "People generally have positive things to say about this place.";
  const negativeSummary = topNegativeTopics.length
    ? `Some reviews mention issues with ${topNegativeTopics.join(" and ")}.`
    : "Only a few minor complaints appear in the reviews.";

  return {
    positive_percentage: positivePercentage,
    positive_summary: positiveSummary,
    negative_percentage: negativePercentage,
    negative_summary: negativeSummary
  };
}

function buildImageGallery(type, name) {
  const imageSets = {
    cafe: [
      "https://images.unsplash.com/photo-1509042239860-f550ce710b93?auto=format&fit=crop&w=1200&q=80",
      "https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=1200&q=80",
      "https://images.unsplash.com/photo-1453614512568-c4024d13c247?auto=format&fit=crop&w=1200&q=80"
    ],
    restaurant: [
      "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?auto=format&fit=crop&w=1200&q=80",
      "https://images.unsplash.com/photo-1552566626-52f8b828add9?auto=format&fit=crop&w=1200&q=80",
      "https://images.unsplash.com/photo-1414235077428-338989a2e8c0?auto=format&fit=crop&w=1200&q=80"
    ],
    fast_food: [
      "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=1200&q=80",
      "https://images.unsplash.com/photo-1513104890138-7c749659a591?auto=format&fit=crop&w=1200&q=80",
      "https://images.unsplash.com/photo-1525059696034-4967a8e1dca2?auto=format&fit=crop&w=1200&q=80"
    ],
    place: [
      "https://images.unsplash.com/photo-1481833761820-0509d3217039?auto=format&fit=crop&w=1200&q=80",
      "https://images.unsplash.com/photo-1559339352-11d035aa65de?auto=format&fit=crop&w=1200&q=80",
      "https://images.unsplash.com/photo-1521017432531-fbd92d768814?auto=format&fit=crop&w=1200&q=80"
    ]
  };

  return (imageSets[type] || imageSets.place).map((url, index) => ({
    url,
    alt: `${name} photo ${index + 1}`
  }));
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
  const type = String(req.query.type || "place").trim();

  if (lat === null || lng === null) {
    return res.status(400).json({ error: "lat and lng are required numeric values." });
  }

  const cacheKey = `${osmType}-${osmId}-${lat}-${lng}`;
  if (placeDetailCache.has(cacheKey)) {
    return res.json(placeDetailCache.get(cacheKey));
  }

  try {
    let address = `${name}, Indonesia`;
    const seed = hashString(cacheKey);

    let googleData = null;
    if (GOOGLE_API_KEY) {
      googleData = await fetchGooglePlaceDetails(lat, lng, name);
    }

    try {
      if (!googleData) {
        const reverse = await reverseGeocode(lat, lng);
        address = reverse.display_name || address;
      } else {
        address = googleData.formatted_address || address;
      }
    } catch {
      address = `${name}, Indonesia`;
    }

    let reviewAnalysis;
    let rating;
    let reviewCount;
    let placeImages = [];

    if (googleData?.reviews) {
      reviewAnalysis = analyzeRealReviews(googleData.reviews, name, cacheKey);
      rating = googleData.rating || 0;
      reviewCount = googleData.user_ratings_total || 0;
    } else {
      const reviews = buildMockReviews(name, type, seed);
      reviewAnalysis = analyzeReviewMix(reviews);
      rating = Number((3.8 + (seed % 12) / 10).toFixed(1));
      reviewCount = 20 + (seed % 180);
    }

    // Use Google photos if available, otherwise fallback to generated images
    if (googleData?.photos && googleData.photos.length > 0) {
      placeImages = googleData.photos.slice(0, 5).map((photo, idx) => ({
        url: `https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photo_reference=${photo.photo_reference}&key=${GOOGLE_API_KEY}`,
        alt: `${name} photo ${idx + 1}`
      }));
    } else {
      placeImages = buildImageGallery(type, name);
    }

    const detail = {
      id: cacheKey,
      name: googleData?.name || name,
      address: googleData?.formatted_address || address,
      coordinates: { lat, lng },
      images: placeImages,
      googleMapsUrl: googleData?.website || buildGoogleMapsLink(lat, lng, name),
      contacts: {
        instagram: googleData?.website ? `https://instagram.com/${name.toLowerCase().replace(/[^a-z0-9]+/g, "")}` : (seed % 2 === 0 ? `https://instagram.com/${name.toLowerCase().replace(/[^a-z0-9]+/g, "")}` : ""),
        website: googleData?.website || (seed % 3 === 0 ? `https://${name.toLowerCase().replace(/[^a-z0-9]+/g, "")}.example.com` : ""),
        phone: googleData?.formatted_phone_number || (seed % 4 === 0 ? `+62 21 ${String(100000 + (seed % 900000)).padStart(6, "0")}` : "")
      },
      rating,
      reviewCount,
      price_range: estimatePriceRange({ amenity: type }),
      review_analysis: reviewAnalysis,
      reviews: googleData?.reviews || [],
      tags: {
        amenity: type
      }
    };

    placeDetailCache.set(cacheKey, detail);
    return res.json(detail);
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to load place details." });
  }
});

export default router;
