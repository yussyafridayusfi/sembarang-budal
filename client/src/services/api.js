const API_BASE = "/api";

async function parseResponse(response) {
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }

  return data;
}

export async function fetchLocations() {
  const response = await fetch(`${API_BASE}/locations`);
  return parseResponse(response);
}

export async function searchLocations(query, signal) {
  const response = await fetch(`${API_BASE}/search?query=${encodeURIComponent(query)}`, { signal });
  return parseResponse(response);
}

export async function saveLocations(locations) {
  const response = await fetch(`${API_BASE}/locations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ locations })
  });

  return parseResponse(response);
}
