<script setup>
import { computed, onMounted, ref } from "vue";
import LocationInput from "./components/LocationInput.vue";
import MapView from "./components/MapView.vue";
import PlaceDetailModal from "./components/PlaceDetailModal.vue";
import { fetchLocations, fetchPlaceDetails, findPlacesNearCenter, saveLocations } from "./services/api";

const draftLocations = ref(["", ""]);
const savedLocations = ref([]);
const loading = ref(false);
const meetingLoading = ref(false);
const error = ref("");
const meetingRadius = ref(1000);
const meetingSearchResult = ref(null);
const selectedPlace = ref(null);
const selectedPlaceDetails = ref(null);
const placeDetailLoading = ref(false);
const placeDetailError = ref("");
const isPlaceDetailOpen = ref(false);
const placeDetailsCache = new Map();

const filledLocations = computed(() =>
  draftLocations.value.map((item) => item.trim()).filter(Boolean)
);

const canSave = computed(() => filledLocations.value.length >= 2 && !loading.value);
const canFindMeetingPoint = computed(() => savedLocations.value.length >= 2 && !meetingLoading.value);

const routeDistanceMeters = computed(() => {
  if (savedLocations.value.length < 2) {
    return 0;
  }

  let total = 0;

  for (let index = 1; index < savedLocations.value.length; index += 1) {
    const previous = savedLocations.value[index - 1];
    const current = savedLocations.value[index];
    total += haversineDistanceMeters(previous.lat, previous.lng, current.lat, current.lng);
  }

  return total;
});

const routeDistanceKm = computed(() => (routeDistanceMeters.value / 1000).toFixed(2));
const routeDistanceMiles = computed(() => (routeDistanceMeters.value / 1609.344).toFixed(2));

function updateDraftLocations(nextLocations) {
  draftLocations.value = nextLocations;
  error.value = "";
}

function computeCentroid(locations) {
  const total = locations.reduce(
    (accumulator, location) => ({
      lat: accumulator.lat + location.lat,
      lng: accumulator.lng + location.lng
    }),
    { lat: 0, lng: 0 }
  );

  return {
    lat: total.lat / locations.length,
    lng: total.lng / locations.length,
    method: "centroid"
  };
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

async function loadSavedLocations() {
  loading.value = true;
  error.value = "";

  try {
    const response = await fetchLocations();
    savedLocations.value = response.locations || [];
    meetingSearchResult.value = null;
    selectedPlace.value = null;
    selectedPlaceDetails.value = null;
    isPlaceDetailOpen.value = false;
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

async function handleSave() {
  if (!canSave.value) {
    error.value = "Please add at least 2 locations before saving.";
    return;
  }

  loading.value = true;
  error.value = "";

  try {
    const response = await saveLocations(filledLocations.value);
    savedLocations.value = response.locations || [];
    meetingSearchResult.value = null;
    selectedPlace.value = null;
    selectedPlaceDetails.value = null;
    isPlaceDetailOpen.value = false;
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

function scorePlace(place, center, locations) {
  const distancesToUsers = locations.map((location) =>
    Math.round(haversineDistanceMeters(location.lat, location.lng, place.lat, place.lng))
  );
  const centerDistance = Math.round(haversineDistanceMeters(center.lat, center.lng, place.lat, place.lng));
  const totalDistance = distancesToUsers.reduce((total, distance) => total + distance, 0);
  const averageDistance = Math.round(totalDistance / distancesToUsers.length);
  const maxDistance = Math.max(...distancesToUsers);
  const minDistance = Math.min(...distancesToUsers);
  const spread = maxDistance - minDistance;

  return {
    ...place,
    centerDistance,
    distancesToUsers,
    averageDistance,
    maxDistance,
    spread,
    score: maxDistance * 0.5 + averageDistance * 0.3 + centerDistance * 0.2
  };
}

async function handleFindMeetingPoint() {
  if (savedLocations.value.length < 2) {
    error.value = "Save at least 2 locations first.";
    return;
  }

  const center = computeCentroid(savedLocations.value);

  meetingLoading.value = true;
  error.value = "";

  try {
    const response = await findPlacesNearCenter(center.lat, center.lng, meetingRadius.value);
    const rankedPlaces = (response.places || [])
      .map((place) => scorePlace(place, center, savedLocations.value))
      .sort((a, b) => a.score - b.score);

    meetingSearchResult.value = {
      center: response.center || center,
      radius: response.radius || meetingRadius.value,
      centerMethod: center.method,
      places: rankedPlaces
    };
    selectedPlace.value = null;
    selectedPlaceDetails.value = null;
    isPlaceDetailOpen.value = false;
  } catch (err) {
    meetingSearchResult.value = {
      center,
      radius: meetingRadius.value,
      centerMethod: center.method,
      places: []
    };
    error.value = err.message;
  } finally {
    meetingLoading.value = false;
  }
}

async function openPlaceDetails(place) {
  selectedPlace.value = place;
  isPlaceDetailOpen.value = true;
  placeDetailError.value = "";

  const cacheKey = place.id || `${place.name}-${place.lat}-${place.lng}`;
  if (placeDetailsCache.has(cacheKey)) {
    selectedPlaceDetails.value = placeDetailsCache.get(cacheKey);
    return;
  }

  placeDetailLoading.value = true;
  selectedPlaceDetails.value = null;

  try {
    const details = await fetchPlaceDetails(place);
    placeDetailsCache.set(cacheKey, details);
    selectedPlaceDetails.value = details;
  } catch (err) {
    placeDetailError.value = err.message;
  } finally {
    placeDetailLoading.value = false;
  }
}

function closePlaceDetails() {
  isPlaceDetailOpen.value = false;
}

async function copyPlaceLocation(place) {
  const address = place.address || place.name || "";

  try {
    await navigator.clipboard.writeText(address);
  } catch {
    error.value = "Failed to copy address.";
  }
}

function formatDistance(distance) {
  if (distance < 1000) {
    return `${distance} m`;
  }

  return `${(distance / 1000).toFixed(1)} km`;
}

onMounted(loadSavedLocations);
</script>

<template>
  <main class="app-shell">
    <MapView
      :locations="savedLocations"
      :meeting-search="meetingSearchResult"
      :selected-place="selectedPlace"
      @select-place="openPlaceDetails"
    />

    <section class="meeting-floating-panel">
      <p class="eyebrow">MEETING POINT</p>
      <h2>Find best meeting point</h2>
      <p class="field-help">Uses all saved locations to calculate a central meeting point.</p>

      <div class="radius-group" role="group" aria-label="Radius selector">
        <button type="button" :class="{ active: meetingRadius === 1000 }" @click="meetingRadius = 1000">1 km</button>
        <button type="button" :class="{ active: meetingRadius === 3000 }" @click="meetingRadius = 3000">3 km</button>
        <button type="button" :class="{ active: meetingRadius === 5000 }" @click="meetingRadius = 5000">5 km</button>
      </div>

      <button class="save-btn middle-btn" :disabled="!canFindMeetingPoint" @click="handleFindMeetingPoint">
        <span v-if="meetingLoading">Searching...</span>
        <span v-else>Find best meeting point</span>
      </button>

      <p v-if="savedLocations.length >= 2" class="middle-summary">
        Route distance: {{ routeDistanceKm }} km / {{ routeDistanceMiles }} miles
      </p>
      <p v-else class="middle-summary muted">Save at least 2 locations to enable this feature.</p>
    </section>

    <aside class="sidebar">
      <div class="sidebar-top">
        <h1>Maps Route Planner</h1>
        <p class="subtitle">Search multiple places, save them, then find a central meeting point for everyone.</p>
      </div>

      <LocationInput :locations="draftLocations" :disabled="loading" @update:locations="updateDraftLocations" />

      <div class="sidebar-actions">
        <button class="save-btn" :disabled="!canSave" @click="handleSave">
          <span v-if="loading">Saving...</span>
          <span v-else>Save Route</span>
        </button>
        <p class="hint">{{ filledLocations.length }} location(s) entered. Minimum 2 required.</p>
        <p v-if="savedLocations.length >= 2" class="hint">Saved route distance: {{ routeDistanceKm }} km / {{ routeDistanceMiles }} miles</p>
        <p v-if="error" class="error">{{ error }}</p>
        <p v-if="savedLocations.length < 2" class="empty-state">No saved route yet.</p>
      </div>

      <div v-if="meetingSearchResult?.places?.length" class="middle-results">
        <h3>Places near the center</h3>
        <ul>
          <li
            v-for="place in meetingSearchResult.places"
            :key="place.id || `${place.name}-${place.lat}-${place.lng}`"
            class="place-item"
            @click="openPlaceDetails(place)"
          >
            <div>
              <strong>{{ place.name }}</strong>
              <p class="place-meta">Center: {{ formatDistance(place.centerDistance) }} | Avg user: {{ formatDistance(place.averageDistance) }}</p>
            </div>
            <span>{{ formatDistance(place.maxDistance) }}</span>
          </li>
        </ul>
      </div>

      <p v-else-if="meetingSearchResult && !meetingLoading" class="empty-state">No places found in this radius.</p>
    </aside>

    <PlaceDetailModal
      :open="isPlaceDetailOpen"
      :place="selectedPlace"
      :details="selectedPlaceDetails"
      :loading="placeDetailLoading"
      :error="placeDetailError"
      @close="closePlaceDetails"
      @copy="copyPlaceLocation"
    />
  </main>
</template>
