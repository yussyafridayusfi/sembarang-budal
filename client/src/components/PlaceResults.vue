<script setup>
import { computed, ref } from "vue";

const props = defineProps({
  result: { type: Object, default: null },
  categories: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  selectedPlaceId: { type: String, default: "" }
});

const emit = defineEmits(["select-place", "hover-place", "retry-live"]);

const sortMode = ref("distance");

const labelByCategory = computed(() =>
  Object.fromEntries(props.categories.map((category) => [category.id, category.label]))
);

const places = computed(() => {
  const list = [...(props.result?.places || [])];

  if (sortMode.value === "name") {
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  if (sortMode.value === "category") {
    return list.sort(
      (a, b) => a.categoryId.localeCompare(b.categoryId) || a.distance - b.distance
    );
  }

  return list.sort((a, b) => a.distance - b.distance);
});

const grouped = computed(() => {
  const counts = new Map();

  (props.result?.places || []).forEach((place) => {
    counts.set(place.categoryId, (counts.get(place.categoryId) || 0) + 1);
  });

  return Array.from(counts, ([categoryId, total]) => ({
    categoryId,
    label: labelByCategory.value[categoryId] || "Other",
    total
  })).sort((a, b) => b.total - a.total);
});

function formatDistance(metres) {
  if (metres < 1000) {
    return `${metres} m`;
  }

  return `${(metres / 1000).toFixed(1)} km`;
}

function walkingMinutes(metres) {
  // ~80 m/min is a normal walking pace.
  return Math.max(1, Math.round(metres / 80));
}

const diagnostics = computed(() => props.result?.diagnostics || null);

/** Shown when a live fetch came back thin, so the user knows why. */
const partialNotice = computed(() => {
  if (!diagnostics.value) {
    return "";
  }

  const failures = diagnostics.value.failures || [];

  if (!failures.length) {
    return "";
  }

  return `${failures.length} upstream ${failures.length === 1 ? "query" : "queries"} failed or timed out. Results may be incomplete.`;
});

/**
 * A cold area is queried for each category's defining tags only, so the first
 * search is fast. Saying so beats letting the list look complete when the
 * long tail is still being fetched.
 */
const fillingIn = computed(() => {
  const diag = diagnostics.value;

  if (!diag?.liveFetch) {
    return "";
  }

  if (diag.backgroundQueued) {
    return "First search in this area — still collecting the less common place types in the background. Search again in a minute for more.";
  }

  if (diag.pendingJobs > 0) {
    return `${diag.pendingJobs} further queries did not fit in the time budget. Refresh for more.`;
  }

  return "";
});
</script>

<template>
  <section class="results">
    <header class="results-header">
      <div>
        <h3>
          {{ loading ? "Searching…" : `${places.length} place${places.length === 1 ? "" : "s"}` }}
        </h3>
        <p v-if="result && !loading" class="results-sub">
          within {{ formatDistance(result.radius) }}
          <span v-if="result.truncated"> · showing the closest {{ places.length }}</span>
        </p>
      </div>

      <label class="sort">
        <span class="sr-only">Sort by</span>
        <select v-model="sortMode">
          <option value="distance">Nearest</option>
          <option value="name">Name</option>
          <option value="category">Category</option>
        </select>
      </label>
    </header>

    <div v-if="grouped.length" class="summary-chips">
      <span v-for="group in grouped" :key="group.categoryId" :class="`tag tag-${group.categoryId}`">
        {{ group.label }} {{ group.total }}
      </span>
    </div>

    <p v-if="partialNotice" class="notice warn">{{ partialNotice }}</p>

    <p v-if="fillingIn && !loading" class="notice subtle">{{ fillingIn }}</p>

    <p v-if="diagnostics && !diagnostics.liveFetch && !loading" class="notice subtle">
      Served from the local database ({{ diagnostics.cachedCount }} cached places in this area).
      <button type="button" class="link-btn" @click="emit('retry-live')">Refresh from OpenStreetMap</button>
    </p>

    <ul v-if="places.length" class="place-list">
      <li
        v-for="place in places"
        :key="place.id"
        class="place-row"
        :class="{ active: place.id === selectedPlaceId }"
        @click="emit('select-place', place)"
        @mouseenter="emit('hover-place', place.id)"
        @mouseleave="emit('hover-place', '')"
      >
        <span :class="`dot dot-${place.categoryId}`" aria-hidden="true"></span>

        <div class="place-body">
          <strong class="place-name">{{ place.name }}</strong>
          <span class="place-type">{{ (place.tagValue || place.type || "").replace(/_/g, " ") }}</span>
          <span v-if="place.address" class="place-address">{{ place.address }}</span>
        </div>

        <div class="place-distance">
          <strong>{{ formatDistance(place.distance) }}</strong>
          <span>{{ walkingMinutes(place.distance) }} min walk</span>
        </div>
      </li>
    </ul>

    <div v-else-if="result && !loading" class="empty">
      <p><strong>Nothing found in this radius.</strong></p>
      <ul>
        <li>Try a bigger radius, or move the centre.</li>
        <li>Select more categories — a single category in a quiet area is often empty.</li>
        <li v-if="partialNotice">Some upstream queries failed; try refreshing.</li>
      </ul>
      <button type="button" class="link-btn" @click="emit('retry-live')">Refresh from OpenStreetMap</button>
    </div>
  </section>
</template>
