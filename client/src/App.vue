<script setup>
import { computed, onMounted, ref, watch } from "vue";
import MapView from "./components/MapView.vue";
import PlaceSearchPanel from "./components/PlaceSearchPanel.vue";
import PlaceResults from "./components/PlaceResults.vue";
import PlaceDetailModal from "./components/PlaceDetailModal.vue";
import MeetingPointPanel from "./components/MeetingPointPanel.vue";
import {
  fetchCategories,
  fetchNearbyPlaces,
  fetchPlaceDetails,
  fetchSavedRoute,
  reverseGeocode
} from "./services/api";

const DEFAULT_CATEGORIES = ["food", "cafe", "shopping", "attraction", "outdoor"];

const mode = ref("explore");
const categories = ref([]);
const selectedCategories = ref([...DEFAULT_CATEGORIES]);
const center = ref(null);
const centerLabel = ref("");
const radius = ref(2000);
const keyword = ref("");

const result = ref(null);
const loading = ref(false);
const locating = ref(false);
const error = ref("");

const routeLocations = ref([]);
const routeCenter = ref(null);
const routeSuggestedRadius = ref(2000);

const selectedPlace = ref(null);
const selectedDetails = ref(null);
const detailLoading = ref(false);
const detailError = ref("");
const detailOpen = ref(false);
const hoveredPlaceId = ref("");

const detailsCache = new Map();
let searchController = null;

const selectedPlaceId = computed(() => selectedPlace.value?.id || "");
const places = computed(() => result.value?.places || []);

async function loadCategories() {
  try {
    const response = await fetchCategories();
    categories.value = response.categories || [];
  } catch (err) {
    error.value = err.message;
  }
}

async function loadSavedRoute() {
  try {
    const response = await fetchSavedRoute();
    routeLocations.value = response.locations || [];
    routeCenter.value = response.center || null;
    routeSuggestedRadius.value = response.suggestedRadius || 2000;
  } catch {
    // A missing saved route is not an error worth showing on first load.
    routeLocations.value = [];
  }
}

async function labelCenter(point) {
  centerLabel.value = `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;

  try {
    const response = await reverseGeocode(point.lat, point.lng);
    centerLabel.value = response.displayName || centerLabel.value;
  } catch {
    // Keep the coordinate label; naming the point is a nicety, not a blocker.
  }
}

async function setCenter(point, { label = "", search = true } = {}) {
  center.value = { lat: point.lat, lng: point.lng };

  if (label) {
    centerLabel.value = label;
  } else {
    labelCenter(point);
  }

  if (search) {
    await runSearch();
  }
}

async function runSearch({ refresh = false } = {}) {
  if (!center.value || !selectedCategories.value.length) {
    return;
  }

  searchController?.abort();
  searchController = new AbortController();

  loading.value = true;
  error.value = "";

  try {
    const response = await fetchNearbyPlaces(
      {
        lat: center.value.lat,
        lng: center.value.lng,
        radius: radius.value,
        categories: selectedCategories.value,
        query: keyword.value.trim(),
        limit: 300,
        refresh
      },
      searchController.signal
    );

    result.value = response;
  } catch (err) {
    if (err.name !== "AbortError") {
      error.value = err.message;
      result.value = { places: [], radius: radius.value, diagnostics: null };
    }
  } finally {
    loading.value = false;
  }
}

function useMyLocation() {
  if (!navigator.geolocation) {
    error.value = "This browser does not support geolocation.";
    return;
  }

  locating.value = true;
  error.value = "";

  navigator.geolocation.getCurrentPosition(
    (position) => {
      locating.value = false;
      setCenter({ lat: position.coords.latitude, lng: position.coords.longitude });
    },
    (geoError) => {
      locating.value = false;
      error.value =
        geoError.code === geoError.PERMISSION_DENIED
          ? "Location permission was denied. Search for a place instead, or click the map."
          : `Could not get your location (${geoError.message}).`;
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

async function openDetails(place) {
  selectedPlace.value = place;
  detailOpen.value = true;
  detailError.value = "";

  if (detailsCache.has(place.id)) {
    selectedDetails.value = detailsCache.get(place.id);
    return;
  }

  detailLoading.value = true;
  selectedDetails.value = null;

  try {
    const details = await fetchPlaceDetails(place);
    detailsCache.set(place.id, details);
    selectedDetails.value = details;
  } catch (err) {
    detailError.value = err.message;
  } finally {
    detailLoading.value = false;
  }
}

function handleRouteSaved(payload) {
  routeLocations.value = payload.locations || [];
  routeCenter.value = payload.center || null;
  routeSuggestedRadius.value = payload.suggestedRadius || 2000;
}

/** Use the saved route's centroid as the search centre - the original
 * "meeting point" idea, now expressed as a way of choosing a centre. */
async function useRouteCenter() {
  if (!routeCenter.value) {
    return;
  }

  radius.value = routeSuggestedRadius.value;
  mode.value = "explore";
  await setCenter(routeCenter.value, { label: `Midpoint of ${routeLocations.value.length} locations` });
}

// Radius and category changes re-run the search; the keyword filter is applied
// server-side too, so it is debounced separately below.
watch([radius, selectedCategories], () => {
  if (center.value) {
    runSearch();
  }
});

let keywordTimer = null;
watch(keyword, () => {
  clearTimeout(keywordTimer);
  keywordTimer = setTimeout(() => {
    if (center.value) {
      runSearch();
    }
  }, 400);
});

onMounted(async () => {
  await Promise.all([loadCategories(), loadSavedRoute()]);
});
</script>

<template>
  <main class="app-shell">
    <MapView
      :center="center"
      :radius="radius"
      :places="places"
      :route-locations="routeLocations"
      :selected-place-id="selectedPlaceId"
      :hovered-place-id="hoveredPlaceId"
      @select-place="openDetails"
      @pick-center="(point) => setCenter(point)"
      @area-changed="(point) => setCenter(point)"
    />

    <aside class="sidebar">
      <div class="brand">
        <h1>Sembarang Budal</h1>
        <p>Find somewhere to go, anywhere inside a radius you choose.</p>
      </div>

      <nav class="mode-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          :aria-selected="mode === 'explore'"
          :class="{ active: mode === 'explore' }"
          @click="mode = 'explore'"
        >
          Explore
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="mode === 'meeting'"
          :class="{ active: mode === 'meeting' }"
          @click="mode = 'meeting'"
        >
          Meeting point
        </button>
      </nav>

      <p v-if="error" class="notice error">{{ error }}</p>

      <template v-if="mode === 'explore'">
        <PlaceSearchPanel
          :center="center"
          :center-label="centerLabel"
          :radius="radius"
          :categories="categories"
          :selected-categories="selectedCategories"
          :keyword="keyword"
          :loading="loading"
          :locating="locating"
          @update:radius="radius = $event"
          @update:selected-categories="selectedCategories = $event"
          @update:keyword="keyword = $event"
          @pick-center="(point) => setCenter(point, { label: point.label })"
          @use-my-location="useMyLocation"
          @search="runSearch"
        />

        <PlaceResults
          :result="result"
          :categories="categories"
          :loading="loading"
          :selected-place-id="selectedPlaceId"
          @select-place="openDetails"
          @hover-place="hoveredPlaceId = $event"
          @retry-live="runSearch({ refresh: true })"
        />
      </template>

      <MeetingPointPanel
        v-else
        :locations="routeLocations"
        :center="routeCenter"
        :suggested-radius="routeSuggestedRadius"
        @saved="handleRouteSaved"
        @use-center="useRouteCenter"
      />
    </aside>

    <PlaceDetailModal
      :open="detailOpen"
      :place="selectedPlace"
      :details="selectedDetails"
      :loading="detailLoading"
      :error="detailError"
      @close="detailOpen = false"
    />
  </main>
</template>
