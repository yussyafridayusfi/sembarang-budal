const API_BASE = "/api";

/**
 * A stable per-browser id so saved routes belong to this browser rather than to
 * a single shared server-side slot.
 */
const ROUTE_ID_KEY = "sembarang-budal:route-id";

function getRouteId() {
  try {
    let id = localStorage.getItem(ROUTE_ID_KEY);

    if (!id) {
      id = `r${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
      localStorage.setItem(ROUTE_ID_KEY, id);
    }

    return id;
  } catch {
    return "default";
  }
}

async function requestJson(url, options = {}) {
  let response;

  try {
    response = await fetch(url, {
      ...options,
      headers: {
        "X-Route-Id": getRouteId(),
        ...(options.headers || {})
      }
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw error;
    }

    throw new Error("Cannot reach the server. Check your connection and try again.");
  }

  const text = await response.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Server returned an unexpected response (${response.status}).`);
  }

  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status}).`);
  }

  return data;
}

export function fetchCategories() {
  return requestJson(`${API_BASE}/categories`);
}

export function searchLocations(query, signal) {
  return requestJson(`${API_BASE}/search?query=${encodeURIComponent(query)}`, { signal });
}

export function reverseGeocode(lat, lng, signal) {
  const params = new URLSearchParams({ lat: String(lat), lng: String(lng) });
  return requestJson(`${API_BASE}/reverse?${params.toString()}`, { signal });
}

export function fetchNearbyPlaces({ lat, lng, radius, categories, query, limit, refresh }, signal) {
  const params = new URLSearchParams({
    lat: String(lat),
    lng: String(lng),
    radius: String(radius)
  });

  if (categories?.length) {
    params.set("categories", categories.join(","));
  }

  if (query) {
    params.set("q", query);
  }

  if (limit) {
    params.set("limit", String(limit));
  }

  if (refresh) {
    params.set("refresh", "1");
  }

  return requestJson(`${API_BASE}/places/nearby?${params.toString()}`, { signal });
}

export function fetchPlaceDetails(place, signal) {
  const params = new URLSearchParams({
    id: String(place.id || ""),
    lat: String(place.lat),
    lng: String(place.lng),
    name: String(place.name || ""),
    type: String(place.tagValue || place.type || "")
  });

  return requestJson(`${API_BASE}/place/details?${params.toString()}`, { signal });
}

export function fetchSavedRoute() {
  return requestJson(`${API_BASE}/locations`);
}

export function saveRoute(locations) {
  return requestJson(`${API_BASE}/locations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ locations })
  });
}

export function clearSavedRoute() {
  return requestJson(`${API_BASE}/locations`, { method: "DELETE" });
}
