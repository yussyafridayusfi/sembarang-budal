<script setup>
import { computed, ref, watch } from "vue";
import { searchLocations } from "../services/api";
import { formatRadius, iconFor } from "../lib/categories";

const props = defineProps({
  center: { type: Object, default: null },
  centerLabel: { type: String, default: "" },
  radius: { type: Number, required: true },
  categories: { type: Array, default: () => [] },
  selectedCategories: { type: Array, default: () => [] },
  keyword: { type: String, default: "" },
  loading: { type: Boolean, default: false },
  locating: { type: Boolean, default: false },
  /** Once results exist the controls fold into a summary bar; the chip strip
   * stays out because changing category is the most common next action. */
  hasResults: { type: Boolean, default: false },
  recent: { type: Array, default: () => [] }
});

const emit = defineEmits([
  "update:radius",
  "update:selectedCategories",
  "update:keyword",
  "pick-center",
  "use-my-location",
  "search",
  "clear-recent"
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
const activeIndex = ref(-1);

const expanded = ref(true);
const inputElement = ref(null);

watch(
  () => props.hasResults,
  (has) => {
    if (has) {
      expanded.value = false;
    }
  }
);

let debounceTimer = null;
let controller = null;

/** Slider steps, so dragging feels sensible across 200 m to 30 km. */
const RADIUS_STEPS = [
  200, 300, 500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 8000, 10000, 12000, 15000,
  20000, 25000, 30000
];

const radiusIndex = computed(() =>
  RADIUS_STEPS.reduce(
    (best, value, index) =>
      Math.abs(value - props.radius) < Math.abs(RADIUS_STEPS[best] - props.radius) ? index : best,
    0
  )
);

const radiusLabel = computed(() => formatRadius(props.radius));

const QUICK_RADII = [500, 1000, 2000, 5000, 10000];

function onRadiusInput(event) {
  emit("update:radius", RADIUS_STEPS[Number(event.target.value)]);
}

function toggleCategory(id) {
  const next = props.selectedCategories.includes(id)
    ? props.selectedCategories.filter((item) => item !== id)
    : [...props.selectedCategories, id];

  emit("update:selectedCategories", next);
}

/** Alt/ctrl-click a chip to solo it - the fastest way to ask "just cafes". */
function chipClick(event, id) {
  if (event.altKey || event.ctrlKey || event.metaKey) {
    emit("update:selectedCategories", [id]);
    return;
  }

  toggleCategory(id);
}

function selectAllCategories() {
  emit(
    "update:selectedCategories",
    props.selectedCategories.length === props.categories.length ? [] : props.categories.map((c) => c.id)
  );
}

function resetSuggestState() {
  suggestions.value = [];
  suggestError.value = "";
  matchedQuery.value = "";
  linkInfo.value = null;
  approximateArea.value = "";
  searched.value = false;
  activeIndex.value = -1;
}

function scheduleSuggest(value) {
  clearTimeout(debounceTimer);
  controller?.abort();

  const query = value.trim();

  if (query.length < 2) {
    resetSuggestState();
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
      activeIndex.value = suggestions.value.length ? 0 : -1;
    } catch (error) {
      if (error.name === "AbortError") {
        // A newer keystroke owns the UI now - leave the spinner to that request
        // rather than clearing it and flashing an empty list.
        return;
      }

      resetSuggestState();
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

function onKeydown(event) {
  if (!showSuggestions.value) {
    return;
  }

  if (event.key === "ArrowDown" && suggestions.value.length) {
    event.preventDefault();
    activeIndex.value = (activeIndex.value + 1) % suggestions.value.length;
  } else if (event.key === "ArrowUp" && suggestions.value.length) {
    event.preventDefault();
    activeIndex.value = (activeIndex.value - 1 + suggestions.value.length) % suggestions.value.length;
  } else if (event.key === "Enter" && activeIndex.value >= 0 && suggestions.value[activeIndex.value]) {
    event.preventDefault();
    chooseSuggestion(suggestions.value[activeIndex.value]);
  } else if (event.key === "Escape") {
    showSuggestions.value = false;
    inputElement.value?.blur();
  }
}

function chooseSuggestion(suggestion) {
  centerQuery.value = "";
  resetSuggestState();
  showSuggestions.value = false;
  emit("pick-center", {
    lat: suggestion.lat,
    lng: suggestion.lng,
    label: suggestion.displayName || suggestion.name
  });
}

function chooseRecent(entry) {
  showSuggestions.value = false;
  emit("pick-center", { lat: entry.lat, lng: entry.lng, label: entry.label });
}

const allSelected = computed(
  () => props.categories.length > 0 && props.selectedCategories.length === props.categories.length
);

const showRecent = computed(
  () => showSuggestions.value && centerQuery.value.trim().length < 2 && props.recent.length > 0
);

const listOpen = computed(
  () =>
    showRecent.value ||
    (showSuggestions.value && (suggestions.value.length || searching.value || suggestError.value || searched.value))
);
</script>

<template>
  <section class="panel search-panel">
    <!-- Search box: always visible, the one thing every session starts with. -->
    <div class="field">
      <div class="combo search-combo" :class="{ open: listOpen }">
        <span class="search-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14"/></svg>
        </span>
        <input
          id="centre-search"
          ref="inputElement"
          type="text"
          role="combobox"
          aria-label="Search centre"
          :aria-expanded="Boolean(listOpen)"
          placeholder="Search a place, address, Maps link or lat,lng"
          autocomplete="off"
          :value="centerQuery"
          @input="onCenterInput"
          @keydown="onKeydown"
          @focus="showSuggestions = true"
          @blur="showSuggestions = false"
        />
        <button
          type="button"
          class="locate-btn"
          :class="{ busy: locating }"
          :disabled="locating"
          :title="locating ? 'Getting your location…' : 'Use my location'"
          aria-label="Use my location"
          @mousedown.prevent
          @click="emit('use-my-location')"
        >
          <span class="locate-glyph" aria-hidden="true"></span>
        </button>

        <ul v-if="listOpen" class="combo-list" role="listbox">
          <template v-if="showRecent">
            <li class="combo-status combo-heading">
              Recent
              <button type="button" class="link-btn" @mousedown.prevent="emit('clear-recent')">Clear</button>
            </li>
            <li v-for="entry in recent" :key="`${entry.lat},${entry.lng}`">
              <button type="button" class="combo-recent" @mousedown.prevent="chooseRecent(entry)">
                <span class="recent-glyph" aria-hidden="true">🕘</span>
                <strong>{{ entry.label }}</strong>
                <span>{{ formatRadius(entry.radius) }} radius</span>
              </button>
            </li>
          </template>

          <template v-else>
            <li v-if="searching" class="combo-status"><span class="spinner" aria-hidden="true"></span> Searching…</li>
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
              <span class="combo-note-title">“{{ linkInfo?.name }}” is not on the map</span>
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
            <li
              v-for="(suggestion, index) in suggestions"
              :key="`${suggestion.osmType}${suggestion.osmId}${suggestion.lat}`"
              role="option"
              :aria-selected="index === activeIndex"
            >
              <button
                type="button"
                :class="{ active: index === activeIndex }"
                @mousedown.prevent="chooseSuggestion(suggestion)"
                @mousemove="activeIndex = index"
              >
                <span class="suggest-glyph" aria-hidden="true">📍</span>
                <strong>{{ suggestion.name }}</strong>
                <span>{{ suggestion.displayName }}</span>
              </button>
            </li>
          </template>
        </ul>
      </div>
    </div>

    <!-- Summary bar: what the search is, with one tap to change it. -->
    <button
      v-if="center"
      type="button"
      class="search-summary"
      :class="{ open: expanded }"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span class="summary-pin" aria-hidden="true"></span>
      <span class="summary-body">
        <strong class="summary-centre" :title="centerLabel">{{ centerLabel || "Chosen point" }}</strong>
        <span class="summary-meta">
          {{ radiusLabel }} radius · {{ selectedCategories.length }} of {{ categories.length }} categories
          <template v-if="keyword.trim()"> · “{{ keyword.trim() }}”</template>
        </span>
      </span>
      <span class="summary-chevron" aria-hidden="true">⌄</span>
    </button>

    <p v-else class="centre-empty">
      <span aria-hidden="true">👆</span>
      Search above, tap the map, or use your location to pick where to look.
    </p>

    <!-- Category strip: horizontal, always visible once a centre exists. -->
    <div v-if="center || !hasResults" class="chip-strip-wrap">
      <div class="chip-strip" role="group" aria-label="Categories">
        <button
          type="button"
          class="chip chip-all"
          :class="{ active: allSelected }"
          :title="allSelected ? 'Clear all categories' : 'Select all categories'"
          @click="selectAllCategories"
        >
          {{ allSelected ? "All ✓" : "All" }}
        </button>
        <button
          v-for="category in categories"
          :key="category.id"
          type="button"
          class="chip"
          :class="[`chip-${category.id}`, { active: selectedCategories.includes(category.id) }]"
          :aria-pressed="selectedCategories.includes(category.id)"
          :title="`${category.label} — alt-click to show only this`"
          @click="chipClick($event, category.id)"
        >
          <span class="chip-glyph" aria-hidden="true">{{ iconFor(category.id) }}</span>
          {{ category.label }}
        </button>
      </div>
    </div>
    <p v-if="!selectedCategories.length" class="field-warn">Pick at least one category.</p>

    <!-- Expanded controls. -->
    <transition name="fold">
      <div v-if="expanded && center" class="search-controls">
        <div class="field">
          <div class="field-row">
            <label for="radius">Radius <span class="radius-value">{{ radiusLabel }}</span></label>
            <div class="quick-radii">
              <button
                v-for="value in QUICK_RADII"
                :key="value"
                type="button"
                :class="{ active: value === radius }"
                @click="emit('update:radius', value)"
              >
                {{ formatRadius(value) }}
              </button>
            </div>
          </div>
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
          <label for="keyword">Filter by name</label>
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
          <span v-if="loading" class="spinner light" aria-hidden="true"></span>
          {{ loading ? "Searching…" : "Search this radius" }}
        </button>
      </div>
    </transition>
  </section>
</template>
