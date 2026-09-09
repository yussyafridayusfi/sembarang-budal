<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import MapView from "./components/MapView.vue";
import PlaceSearchPanel from "./components/PlaceSearchPanel.vue";
import PlaceResults from "./components/PlaceResults.vue";
import PlaceDetailModal from "./components/PlaceDetailModal.vue";
import MeetingPointPanel from "./components/MeetingPointPanel.vue";
import {
  clearSavedRoute,
  fetchCategories,
  fetchNearbyPlaces,
  fetchPlaceDetails,
  fetchSavedRoute,
  reverseGeocode
} from "./services/api";

const DEFAULT_CATEGORIES = ["food", "cafe", "shopping", "attraction", "outdoor"];
const DEFAULT_RADIUS = 2000;
const RECENT_KEY = "sembarang-budal:recent";
const SIDEBAR_WIDTH = 420;
const MOBILE_BREAKPOINT = 720;

const mode = ref("explore");
const categories = ref([]);
const selectedCategories = ref([...DEFAULT_CATEGORIES]);
const center = ref(null);
/** The map's current view centre: what a text search is biased towards when
 * no search centre has been chosen yet (Indonesia at first, then wherever the
 * person has panned). */
const viewCenter = ref({
  lat: -2.5,
  lng: 118,
  zoom: 5,
  bounds: { minLat: -11, minLng: 95, maxLat: 6, maxLng: 141 }
});
const searchBias = computed(() => center.value || viewCenter.value);
const centerLabel = ref("");
const radius = ref(DEFAULT_RADIUS);
const keyword = ref("");

const result = ref(null);
const loading = ref(false);
const locating = ref(false);
const error = ref("");

const routeLocations = ref([]);
const routeCenter = ref(null);
const routeSuggestedRadius = ref(DEFAULT_RADIUS);

/* ---------------------------------------------------------- install (PWA) */

/** The deferred `beforeinstallprompt` event, while the browser offers install. */
const installPrompt = ref(null);
const installed = ref(window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true);

function onBeforeInstallPrompt(event) {
  event.preventDefault();
  installPrompt.value = event;
}

function onAppInstalled() {
  installPrompt.value = null;
  installed.value = true;
}

async function installApp() {
  const prompt = installPrompt.value;

  if (!prompt) {
    return;
  }

  prompt.prompt();
  await prompt.userChoice.catch(() => null);
  installPrompt.value = null;
}

const selectedPlace = ref(null);
const selectedDetails = ref(null);
const detailLoading = ref(false);
const detailError = ref("");
const detailOpen = ref(false);
const hoveredPlaceId = ref("");

/** Desktop: the panel slides off to the left. Mobile: the sheet peeks or opens. */
const sidebarOpen = ref(true);
const sheetState = ref("half"); // peek | half | full
const viewportWidth = ref(window.innerWidth);
const isMobile = computed(() => viewportWidth.value <= MOBILE_BREAKPOINT);
const insetLeft = computed(() => (!isMobile.value && sidebarOpen.value ? SIDEBAR_WIDTH + 16 : 0));

const recent = ref(loadRecent());

/** The sticky brand header, measured so the results header can sit right
 * below it whatever the header currently contains. */
const brandElement = ref(null);
let brandObserver = null;

const detailsCache = new Map();
let searchController = null;

/* -------------------------------------------------------------- start over */

/** Bumped on a reset: remounting the panels drops the text, suggestions and
 * half-filled rows they keep locally, which clearing the shared state alone
 * would leave behind. */
const resetToken = ref(0);
const resetConfirm = ref(false);
const resetting = ref(false);

/** What a reset would actually clear, named so the confirmation can list it. */
const resetItems = computed(() => {
  const items = [];

  if (center.value || result.value) {
    items.push("the current search");
  }

  if (recent.value.length) {
    items.push(`${recent.value.length} recent ${recent.value.length === 1 ? "centre" : "centres"}`);
  }

  if (routeLocations.value.length) {
    items.push(
      `${routeLocations.value.length} saved meeting-point ${routeLocations.value.length === 1 ? "location" : "locations"}`
    );
  }

  return items;
});

const canReset = computed(() => resetItems.value.length > 0 || keyword.value.trim().length > 0);

const resetSummary = computed(() => {
  const items = resetItems.value;

  if (items.length <= 1) {
    return items[0] || "the current search";
  }

  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
});

/**
 * Back to how the app opens: no centre, default radius and categories, no
 * results, no recent centres, and no saved meeting-point route. The saved
 * route lives on the server, so that one is a request.
 */
async function resetAll() {
  resetting.value = true;
  searchController?.abort();
  searchController = null;

  center.value = null;
  centerLabel.value = "";
  radius.value = DEFAULT_RADIUS;
  selectedCategories.value = [...DEFAULT_CATEGORIES];
  keyword.value = "";
  result.value = null;
  error.value = "";
  loading.value = false;

  detailOpen.value = false;
  selectedPlace.value = null;
  selectedDetails.value = null;
  detailError.value = "";
  hoveredPlaceId.value = "";
  detailsCache.clear();

  clearRecent();

  try {
    await clearSavedRoute();
  } catch {
    // The local copy is gone either way, and the next save overwrites the
    // server's - not worth blocking the reset over.
  }

  routeLocations.value = [];
  routeCenter.value = null;
  routeSuggestedRadius.value = DEFAULT_RADIUS;

  mode.value = "explore";
  sidebarOpen.value = true;
  sheetState.value = "half";
  history.replaceState(null, "", window.location.pathname);

  resetToken.value += 1;
  resetConfirm.value = false;
  resetting.value = false;
}

const selectedPlaceId = computed(() => selectedPlace.value?.id || "");
const places = computed(() => result.value?.places || []);
const hasResults = computed(() => Boolean(result.value));

/* --------------------------------------------------------------- recents */

function loadRecent() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.slice(0, 6) : [];
  } catch {
    return [];
  }
}

function rememberRecent(entry) {
  const key = `${entry.lat.toFixed(4)},${entry.lng.toFixed(4)}`;
  const next = [
    entry,
    ...recent.value.filter((item) => `${item.lat.toFixed(4)},${item.lng.toFixed(4)}` !== key)
  ].slice(0, 6);
  recent.value = next;

  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage may be unavailable; recents are a convenience only.
  }
}

function clearRecent() {
  recent.value = [];

  try {
    localStorage.removeItem(RECENT_KEY);
  } catch {
    // ignore
  }
}

/* -------------------------------------------------------------- URL state */

/** The search lives in the URL hash so it can be sent to the people you are
 * meeting: #c=lat,lng&r=2000&cat=food,cafe&q=kopi */
function readHash() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const [lat, lng] = (params.get("c") || "").split(",").map(Number);
  const r = Number(params.get("r"));
  const cats = (params.get("cat") || "").split(",").filter(Boolean);

  return {
    center: Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null,
    radius: Number.isFinite(r) && r >= 200 && r <= 30000 ? r : null,
    categories: cats.length ? cats : null,
    keyword: params.get("q") || ""
  };
}

function writeHash() {
  if (!center.value) {
    return;
  }

  const params = new URLSearchParams();
  params.set("c", `${center.value.lat.toFixed(5)},${center.value.lng.toFixed(5)}`);
  params.set("r", String(radius.value));
  params.set("cat", selectedCategories.value.join(","));

  if (keyword.value.trim()) {
    params.set("q", keyword.value.trim());
  }

  history.replaceState(null, "", `#${params.toString()}`);
}

/* ----------------------------------------------------------------- loads */

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

  rememberRecent({ lat: point.lat, lng: point.lng, label: centerLabel.value, radius: radius.value });
}

async function setCenter(point, { label = "", search = true } = {}) {
  center.value = { lat: point.lat, lng: point.lng };
  selectedPlace.value = null;

  if (label) {
    centerLabel.value = label;
    rememberRecent({ lat: point.lat, lng: point.lng, label, radius: radius.value });
  } else {
    labelCenter(point);
  }

  if (isMobile.value) {
    sheetState.value = "half";
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
  writeHash();

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

  if (!window.isSecureContext) {
    error.value = "Location needs a secure (https) page. Search for a place instead, or tap the map.";
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
          ? "Location permission was denied. Search for a place instead, or tap the map."
          : `Could not get your location (${geoError.message}).`;
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

/* --------------------------------------------------------------- details */

/** Highlight on the map and in the list without opening the full sheet. */
function previewPlace(place) {
  selectedPlace.value = place;

  if (isMobile.value && sheetState.value === "full") {
    sheetState.value = "half";
  }
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

function cycleSheet() {
  sheetState.value = sheetState.value === "peek" ? "half" : sheetState.value === "half" ? "full" : "peek";
}

/* -------------------------------------------------------------- watchers */

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

// An error is worth seeing, but not forever.
let errorTimer = null;
watch(error, (value) => {
  clearTimeout(errorTimer);

  if (value) {
    errorTimer = setTimeout(() => {
      error.value = "";
    }, 8000);
  }
});

function onResize() {
  viewportWidth.value = window.innerWidth;
}

function onGlobalKeydown(event) {
  if (event.key === "Escape" && resetConfirm.value) {
    resetConfirm.value = false;
    return;
  }

  if (event.key === "Escape" && !detailOpen.value && selectedPlace.value) {
    selectedPlace.value = null;
  }

  // "/" focuses the search box, as on most keyboard-friendly sites.
  if (event.key === "/" && !/^(input|textarea|select)$/i.test(event.target?.tagName || "")) {
    event.preventDefault();
    sidebarOpen.value = true;
    document.getElementById("centre-search")?.focus();
  }
}

onMounted(async () => {
  window.addEventListener("resize", onResize);
  document.addEventListener("keydown", onGlobalKeydown);

  if (brandElement.value && window.ResizeObserver) {
    brandObserver = new ResizeObserver(([entry]) => {
      document.documentElement.style.setProperty("--brand-height", `${entry.target.offsetHeight}px`);
    });
    brandObserver.observe(brandElement.value);
  }

  const fromHash = readHash();

  if (fromHash.radius) radius.value = fromHash.radius;
  if (fromHash.categories) selectedCategories.value = fromHash.categories;
  if (fromHash.keyword) keyword.value = fromHash.keyword;

  await Promise.all([loadCategories(), loadSavedRoute()]);

  if (fromHash.center) {
    setCenter(fromHash.center);
  }
});

onBeforeUnmount(() => {
  brandObserver?.disconnect();
  window.removeEventListener("resize", onResize);
  document.removeEventListener("keydown", onGlobalKeydown);
  window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  window.removeEventListener("appinstalled", onAppInstalled);
});

window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
window.addEventListener("appinstalled", onAppInstalled);

// Manifest shortcuts land here with a query string; honour it once, then
// let the hash carry the state as usual.
const launchParams = new URLSearchParams(window.location.search);

if (launchParams.get("mode") === "meeting") {
  mode.value = "meeting";
}

if (launchParams.get("near") === "me" && !window.location.hash) {
  useMyLocation();
}

if (launchParams.toString()) {
  window.history.replaceState(null, "", window.location.pathname + window.location.hash);
}
</script>

<template>
  <main class="app-shell" :class="{ 'sidebar-closed': !sidebarOpen, [`sheet-${sheetState}`]: isMobile }">
    <MapView
      :center="center"
      :radius="radius"
      :places="places"
      :route-locations="routeLocations"
      :selected-place-id="selectedPlaceId"
      :hovered-place-id="hoveredPlaceId"
      :inset-left="insetLeft"
      :locating="locating"
      @select-place="openDetails"
      @preview-place="previewPlace"
      @hover-place="hoveredPlaceId = $event"
      @pick-center="(point) => setCenter(point)"
      @area-changed="(point) => setCenter(point)"
      @view-changed="viewCenter = $event"
      @update:radius="radius = $event"
      @use-my-location="useMyLocation"
    />

    <!-- Desktop: a tab on the panel's edge collapses it so the map runs full width. -->
    <button
      v-if="!isMobile"
      type="button"
      class="sidebar-toggle"
      :aria-expanded="sidebarOpen"
      :title="sidebarOpen ? 'Hide panel' : 'Show panel'"
      @click="sidebarOpen = !sidebarOpen"
    >
      <span aria-hidden="true">{{ sidebarOpen ? "‹" : "›" }}</span>
      <span class="sr-only">{{ sidebarOpen ? "Hide panel" : "Show panel" }}</span>
    </button>

    <aside class="sidebar" :aria-hidden="!isMobile && !sidebarOpen">
      <!-- Mobile: the grip cycles peek → half → full. -->
      <button v-if="isMobile" type="button" class="sheet-handle" aria-label="Resize panel" @click="cycleSheet">
        <span></span>
      </button>

      <header ref="brandElement" class="brand">
        <div class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7m0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5"/></svg>
        </div>
        <div>
          <h1>Sembarang Budal</h1>
          <p>Somewhere to go, anywhere inside a radius you choose.</p>
        </div>

        <div class="brand-actions">
          <button
            v-if="installPrompt && !installed"
            type="button"
            class="install-btn"
            title="Install as an app on this device"
            @click="installApp"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M5 20h14v-2H5zm7-18-5.5 5.5 1.41 1.41L11 5.83V16h2V5.83l3.09 3.08 1.41-1.41z" transform="rotate(180 12 12)"/></svg>
            <span class="btn-label">Install</span>
          </button>

          <button
            v-if="canReset"
            type="button"
            class="reset-btn"
            :aria-expanded="resetConfirm"
            title="Start over — clears the search, recent centres and saved locations"
            aria-label="Start over"
            @click="resetConfirm = !resetConfirm"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8"/></svg>
            <span class="btn-label">Start over</span>
          </button>
        </div>
        <nav class="mode-tabs" role="tablist" aria-label="Mode">
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
            Meet up
          </button>
        </nav>
      </header>

      <transition name="fold">
        <div v-if="resetConfirm" class="reset-confirm" role="alertdialog" aria-label="Start over">
          <p>
            <strong>Start over?</strong>
            This clears {{ resetSummary }}. It cannot be undone.
          </p>
          <div class="reset-actions">
            <button type="button" class="primary-btn danger" :disabled="resetting" @click="resetAll">
              {{ resetting ? "Clearing…" : "Clear everything" }}
            </button>
            <button type="button" class="link-btn" @click="resetConfirm = false">Cancel</button>
          </div>
        </div>
      </transition>

      <transition name="fold">
        <p v-if="error" class="notice error" role="alert">
          {{ error }}
          <button type="button" class="notice-dismiss" aria-label="Dismiss" @click="error = ''">×</button>
        </p>
      </transition>

      <template v-if="mode === 'explore'">
        <PlaceSearchPanel
          :key="resetToken"
          :center="center"
          :center-label="centerLabel"
          :radius="radius"
          :categories="categories"
          :selected-categories="selectedCategories"
          :keyword="keyword"
          :loading="loading"
          :locating="locating"
          :has-results="hasResults"
          :recent="recent"
          :map-center="searchBias"
          @update:radius="radius = $event"
          @update:selected-categories="selectedCategories = $event"
          @update:keyword="keyword = $event"
          @pick-center="(point) => setCenter(point, { label: point.label })"
          @use-my-location="useMyLocation"
          @search="runSearch"
          @clear-recent="clearRecent"
        />

        <PlaceResults
          v-if="center"
          :result="result"
          :categories="categories"
          :loading="loading"
          :selected-place-id="selectedPlaceId"
          :hovered-place-id="hoveredPlaceId"
          @select-place="openDetails"
          @preview-place="previewPlace"
          @hover-place="hoveredPlaceId = $event"
          @retry-live="runSearch({ refresh: true })"
        />

        <section v-else class="welcome">
          <h2>How it works</h2>
          <ol>
            <li><strong>Pick a centre</strong> — search, tap the map, or use your location.</li>
            <li><strong>Set the radius</strong> — drag the ring on the map, or use the slider.</li>
            <li><strong>Browse</strong> — filter by category, tap a pin, open the details.</li>
          </ol>
          <p class="welcome-tip">Tip: press <kbd>/</kbd> to jump to the search box.</p>
        </section>
      </template>

      <MeetingPointPanel
        v-else
        :key="resetToken"
        :locations="routeLocations"
        :center="routeCenter"
        :map-center="searchBias"
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
