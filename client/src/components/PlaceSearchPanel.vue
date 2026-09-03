<script setup>
import { computed, ref } from "vue";
import { searchLocations } from "../services/api";

const props = defineProps({
  center: { type: Object, default: null },
  centerLabel: { type: String, default: "" },
  radius: { type: Number, required: true },
  categories: { type: Array, default: () => [] },
  selectedCategories: { type: Array, default: () => [] },
  keyword: { type: String, default: "" },
  loading: { type: Boolean, default: false },
  locating: { type: Boolean, default: false }
});

const emit = defineEmits([
  "update:radius",
  "update:selectedCategories",
  "update:keyword",
  "pick-center",
  "use-my-location",
  "search"
]);

const centerQuery = ref("");
const suggestions = ref([]);
const searching = ref(false);
const showSuggestions = ref(false);
/** Set once a lookup has finished, so an empty list can say why it is empty.
 * Previously a failed or empty lookup rendered nothing at all - no results, no
 * message - which is indistinguishable from the app ignoring the keystroke. */
const suggestError = ref("");
const searched = ref(false);
/** Set when the server had to relax the query to find anything, so the list can
 * say which question it is actually answering. */
const matchedQuery = ref("");
/** How a pasted Google link was read, so the UI can say whether it pinpointed
 * the place or only gave us its name to look up. */
const linkInfo = ref(null);
/** Set when only the link's surrounding area could be resolved, not the place. */
const approximateArea = ref("");

let debounceTimer = null;
let controller = null;

/** Slider steps, so dragging feels sensible across 200 m to 30 km. */
const RADIUS_STEPS = [
  200, 300, 500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 8000, 10000, 12000, 15000,
  20000, 25000, 30000
];

const radiusIndex = computed(() => {
  const closest = RADIUS_STEPS.reduce(
    (best, value, index) =>
      Math.abs(value - props.radius) < Math.abs(RADIUS_STEPS[best] - props.radius) ? index : best,
    0
  );

  return closest;
});

const radiusLabel = computed(() =>
  props.radius >= 1000 ? `${(props.radius / 1000).toFixed(props.radius % 1000 === 0 ? 0 : 1)} km` : `${props.radius} m`
);

function onRadiusInput(event) {
  emit("update:radius", RADIUS_STEPS[Number(event.target.value)]);
}

function toggleCategory(id) {
  const next = props.selectedCategories.includes(id)
    ? props.selectedCategories.filter((item) => item !== id)
    : [...props.selectedCategories, id];

  emit("update:selectedCategories", next);
}

function selectAllCategories() {
  emit(
    "update:selectedCategories",
    props.selectedCategories.length === props.categories.length ? [] : props.categories.map((c) => c.id)
  );
}

function scheduleSuggest(value) {
  clearTimeout(debounceTimer);
  controller?.abort();

  const query = value.trim();

  if (query.length < 2) {
    suggestions.value = [];
    suggestError.value = "";
    matchedQuery.value = "";
    linkInfo.value = null;
    approximateArea.value = "";
    searched.value = false;
    searching.value = false;
    return;
  }

  searching.value = true;
  showSuggestions.value = true;
  suggestError.value = "";

  debounceTimer = setTimeout(async () => {
    const request = new AbortController();
    controller = request;

    try {
      const response = await searchLocations(query, request.signal, props.center);
      suggestions.value = response.suggestions || [];
      matchedQuery.value = response.matchedQuery || "";
      linkInfo.value = response.link || null;
      approximateArea.value = response.approximateArea || "";
      searched.value = true;
    } catch (error) {
      if (error.name === "AbortError") {
        // A newer keystroke owns the UI now - leave the spinner to that request
        // rather than clearing it and flashing an empty list.
        return;
      }

      suggestions.value = [];
      matchedQuery.value = "";
      linkInfo.value = null;
      approximateArea.value = "";
      suggestError.value = error.message || "Address lookup failed.";
      searched.value = true;
    } finally {
      if (controller === request) {
        searching.value = false;
      }
    }
  }, 350);
}

function onCenterInput(event) {
  centerQuery.value = event.target.value;
  scheduleSuggest(event.target.value);
}

function chooseSuggestion(suggestion) {
  centerQuery.value = "";
  suggestions.value = [];
  suggestError.value = "";
  matchedQuery.value = "";
  linkInfo.value = null;
  approximateArea.value = "";
  searched.value = false;
  showSuggestions.value = false;
  emit("pick-center", {
    lat: suggestion.lat,
    lng: suggestion.lng,
    label: suggestion.displayName || suggestion.name
  });
}

const allSelected = computed(
  () => props.categories.length > 0 && props.selectedCategories.length === props.categories.length
);
</script>

<template>
  <section class="panel">
    <header class="panel-header">
      <h2>Find places to go</h2>
      <p class="panel-sub">Pick a centre, choose a radius, and see everything inside it.</p>
    </header>

    <div class="field">
      <label for="centre-search">Search centre</label>
      <div class="combo">
        <input
          id="centre-search"
          type="text"
          placeholder="Place, address, Maps link, or lat,lng"
          autocomplete="off"
          :value="centerQuery"
          @input="onCenterInput"
          @focus="showSuggestions = true"
          @blur="showSuggestions = false"
        />

        <ul
          v-if="showSuggestions && (suggestions.length || searching || suggestError || searched)"
          class="combo-list"
        >
          <li v-if="searching" class="combo-status">Searching…</li>
          <li v-else-if="suggestError" class="combo-status combo-error">{{ suggestError }}</li>
          <li v-else-if="!suggestions.length && linkInfo" class="combo-status combo-error">
            <span class="combo-note-title">Not on the map: “{{ linkInfo.name }}”</span>
            <span class="combo-note-body">
              That link carries only a name. Share from Google Maps for the exact position, or
              click the map to place the point.
            </span>
          </li>
          <li v-else-if="!suggestions.length" class="combo-status">
            No places match “{{ centerQuery.trim() }}”. Try adding a city, or click the map.
          </li>
          <li v-else-if="approximateArea" class="combo-relaxed combo-status">
            <span class="combo-note-title">
              “{{ linkInfo?.name }}” is not on the map
            </span>
            <span class="combo-note-body">
              Showing {{ approximateArea }}, the area named in the link. Drop a pin on the map if
              you need the exact spot.
            </span>
          </li>
          <li v-else-if="linkInfo && linkInfo.kind === 'name'" class="combo-relaxed combo-status">
            <span class="combo-note-title">Link gave a name, not a position</span>
            <span class="combo-note-body">
              Looked up “{{ linkInfo.name }}” — check the match below is the right one.
            </span>
          </li>
          <li v-else-if="matchedQuery" class="combo-status combo-relaxed">
            No exact match. Showing results for “{{ matchedQuery }}”.
          </li>
          <li v-for="suggestion in suggestions" :key="`${suggestion.osmType}${suggestion.osmId}${suggestion.lat}`">
            <button type="button" @mousedown.prevent="chooseSuggestion(suggestion)">
              <strong>{{ suggestion.name }}</strong>
              <span>{{ suggestion.displayName }}</span>
            </button>
          </li>
        </ul>
      </div>

      <button type="button" class="link-btn" :disabled="locating" @click="emit('use-my-location')">
        {{ locating ? "Getting your location…" : "Use my location" }}
      </button>

      <p v-if="centerLabel" class="centre-label" :title="centerLabel">
        Centre: <strong>{{ centerLabel }}</strong>
      </p>
      <p v-else class="centre-label muted">No centre set yet. Search above, or click the map.</p>
    </div>

    <div class="field">
      <label for="radius">Radius <span class="radius-value">{{ radiusLabel }}</span></label>
      <input
        id="radius"
        type="range"
        min="0"
        :max="RADIUS_STEPS.length - 1"
        step="1"
        :value="radiusIndex"
        @input="onRadiusInput"
      />
      <div class="radius-scale"><span>200 m</span><span>30 km</span></div>
    </div>

    <div class="field">
      <div class="field-row">
        <label>Categories</label>
        <button type="button" class="link-btn" @click="selectAllCategories">
          {{ allSelected ? "Clear all" : "Select all" }}
        </button>
      </div>

      <div class="chips">
        <button
          v-for="category in categories"
          :key="category.id"
          type="button"
          class="chip"
          :class="[`chip-${category.id}`, { active: selectedCategories.includes(category.id) }]"
          @click="toggleCategory(category.id)"
        >
          {{ category.label }}
        </button>
      </div>
      <p v-if="!selectedCategories.length" class="field-warn">Pick at least one category.</p>
    </div>

    <div class="field">
      <label for="keyword">Filter by name (optional)</label>
      <input
        id="keyword"
        type="text"
        placeholder="e.g. kopi, bakso, mall"
        :value="keyword"
        @input="emit('update:keyword', $event.target.value)"
      />
    </div>

    <button
      type="button"
      class="primary-btn"
      :disabled="loading || !center || !selectedCategories.length"
      @click="emit('search')"
    >
      {{ loading ? "Searching…" : "Search this radius" }}
    </button>
  </section>
</template>
