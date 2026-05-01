<script setup>
import { computed, onMounted, ref } from "vue";
import LocationInput from "./components/LocationInput.vue";
import MapView from "./components/MapView.vue";
import { fetchLocations, findPlacesInMiddle, saveLocations } from "./services/api";

const draftLocations = ref(["", ""]);
const savedLocations = ref([]);
const loading = ref(false);
const middleLoading = ref(false);
const error = ref("");
const middleRadius = ref(1000);
const middleSearchResult = ref(null);

const filledLocations = computed(() =>
  draftLocations.value.map((item) => item.trim()).filter(Boolean)
);

const canSave = computed(() => filledLocations.value.length >= 2 && !loading.value);
const canFindMiddle = computed(() => savedLocations.value.length >= 2 && !middleLoading.value);

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

function computeMidpoint(a, b) {
  return {
    lat: (a.lat + b.lat) / 2,
    lng: (a.lng + b.lng) / 2
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
    middleSearchResult.value = null;
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
    middleSearchResult.value = null;
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

async function handleFindPlacesInMiddle() {
  if (savedLocations.value.length < 2) {
    error.value = "Save at least 2 locations first.";
    return;
  }

  const midpoint = computeMidpoint(savedLocations.value[0], savedLocations.value[1]);

  middleLoading.value = true;
  error.value = "";

  try {
    const response = await findPlacesInMiddle(midpoint.lat, midpoint.lng, middleRadius.value);
    middleSearchResult.value = {
      midpoint: response.midpoint || midpoint,
      radius: response.radius || middleRadius.value,
      places: response.places || []
    };
  } catch (err) {
    middleSearchResult.value = {
      midpoint,
      radius: middleRadius.value,
      places: []
    };
    error.value = err.message;
  } finally {
    middleLoading.value = false;
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
    <MapView :locations="savedLocations" :middle-search="middleSearchResult" />

    <section class="middle-floating-panel">
      <p class="eyebrow">MIDDLE FINDER</p>
      <h2>Find places in the middle</h2>
      <p class="field-help">This searches near the midpoint of your first 2 saved locations.</p>

      <div class="radius-group" role="group" aria-label="Radius selector">
        <button type="button" :class="{ active: middleRadius === 1000 }" @click="middleRadius = 1000">1 km</button>
        <button type="button" :class="{ active: middleRadius === 3000 }" @click="middleRadius = 3000">3 km</button>
        <button type="button" :class="{ active: middleRadius === 5000 }" @click="middleRadius = 5000">5 km</button>
      </div>

      <button class="save-btn middle-btn" :disabled="!canFindMiddle" @click="handleFindPlacesInMiddle">
        <span v-if="middleLoading">Searching...</span>
        <span v-else>Find places in the middle</span>
      </button>

      <p v-if="savedLocations.length >= 2" class="middle-summary">
        Route distance: {{ routeDistanceKm }} km / {{ routeDistanceMiles }} miles
      </p>
      <p v-else class="middle-summary muted">Save at least 2 locations to enable this feature.</p>
    </section>

    <aside class="sidebar">
      <div class="sidebar-top">
        <h1>Maps Route Planner</h1>
        <p class="subtitle">Search multiple places on the left and save to draw the route on the map.</p>
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

      <div v-if="middleSearchResult?.places?.length" class="middle-results">
        <h3>Nearby places</h3>
        <ul>
          <li v-for="place in middleSearchResult.places" :key="`${place.name}-${place.lat}-${place.lng}`">
            <strong>{{ place.name }}</strong>
            <span>{{ formatDistance(place.distance) }}</span>
          </li>
        </ul>
      </div>

      <p v-else-if="middleSearchResult && !middleLoading" class="empty-state">No places found in this radius.</p>
    </aside>
  </main>
</template>
