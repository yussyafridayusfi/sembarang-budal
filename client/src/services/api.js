const API_BASE = "/api";

function getFriendlyNetworkError() {
  return new Error("Cannot reach the backend API. Make sure `npm run dev` is running.");
}

async function parseResponse(response) {
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }

  return data;
}

async function requestJson(url, options) {
  try {
    const response = await fetch(url, options);
    return parseResponse(response);
  } catch (error) {
    if (error instanceof TypeError) {
      throw getFriendlyNetworkError();
    }

    throw error;
  }
}

export async function fetchLocations() {
  return requestJson(`${API_BASE}/locations`);
}

export async function searchLocations(query, signal) {
  return requestJson(`${API_BASE}/search?query=${encodeURIComponent(query)}`, { signal });
}

export async function saveLocations(locations) {
  return requestJson(`${API_BASE}/locations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ locations })
  });
}

export async function findPlacesInMiddle(lat, lng, radius) {
  const query = new URLSearchParams({
    lat: String(lat),
    lng: String(lng),
    radius: String(radius)
  });

  return requestJson(`${API_BASE}/places/middle?${query.toString()}`);
}
