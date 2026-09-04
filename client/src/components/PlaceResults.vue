<script setup>
import { computed, nextTick, ref, watch } from "vue";
import {
  colorFor,
  displayName,
  formatDistance,
  iconFor,
  ridingMinutes,
  typeLabel,
  walkingMinutes
} from "../lib/categories";

const props = defineProps({
  result: { type: Object, default: null },
  categories: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  selectedPlaceId: { type: String, default: "" },
  hoveredPlaceId: { type: String, default: "" }
});

const emit = defineEmits(["select-place", "preview-place", "hover-place", "retry-live"]);

const sortMode = ref("distance");
/** A quick client-side narrowing by category, on top of the server search. */
const filterCategory = ref("");
const listElement = ref(null);

const labelByCategory = computed(() =>
  Object.fromEntries(props.categories.map((category) => [category.id, category.label]))
);

const allPlaces = computed(() => props.result?.places || []);

const places = computed(() => {
  let list = [...allPlaces.value];

  if (filterCategory.value) {
    list = list.filter((place) => place.categoryId === filterCategory.value);
  }

  if (sortMode.value === "name") {
    return list.sort((a, b) => displayName(a).localeCompare(displayName(b)));
  }

  if (sortMode.value === "category") {
    return list.sort((a, b) => a.categoryId.localeCompare(b.categoryId) || a.distance - b.distance);
  }

  return list.sort((a, b) => a.distance - b.distance);
});

const grouped = computed(() => {
  const counts = new Map();

  allPlaces.value.forEach((place) => {
    counts.set(place.categoryId, (counts.get(place.categoryId) || 0) + 1);
  });

  return Array.from(counts, ([categoryId, total]) => ({
    categoryId,
    label: labelByCategory.value[categoryId] || "Other",
    total
  })).sort((a, b) => b.total - a.total);
});

// A new result set may no longer contain the filtered category.
watch(allPlaces, () => {
  if (filterCategory.value && !allPlaces.value.some((place) => place.categoryId === filterCategory.value)) {
    filterCategory.value = "";
  }
});

function toggleFilter(categoryId) {
  filterCategory.value = filterCategory.value === categoryId ? "" : categoryId;
}

const diagnostics = computed(() => props.result?.diagnostics || null);

/** Shown when a live fetch came back thin, so the user knows why. */
const partialNotice = computed(() => {
  const failures = diagnostics.value?.failures || [];

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
    return "First search here — still collecting the less common place types in the background. Search again in a minute for more.";
  }

  if (diag.pendingJobs > 0) {
    return `${diag.pendingJobs} further queries did not fit in the time budget. Refresh for more.`;
  }

  return "";
});

// Keep the highlighted row in view when the selection comes from the map.
watch(
  () => props.selectedPlaceId,
  async (id) => {
    if (!id) {
      return;
    }

    await nextTick();
    listElement.value
      ?.querySelector(`[data-place-id="${CSS.escape(id)}"]`)
      // "center" rather than "nearest": the sticky brand and results headers
      // would otherwise cover a row that lands at the top of the scroller.
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
);

function onRowKeydown(event, place) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    emit("select-place", place);
  }
}

const headline = computed(() => {
  if (props.loading) {
    return "Searching…";
  }

  const total = allPlaces.value.length;

  if (filterCategory.value) {
    return `${places.value.length} of ${total} place${total === 1 ? "" : "s"}`;
  }

  return `${total} place${total === 1 ? "" : "s"}`;
});
</script>

<template>
  <section class="results" aria-live="polite">
    <header class="results-header">
      <div class="results-title">
        <h3>{{ headline }}</h3>
        <p v-if="result && !loading" class="results-sub">
          within {{ formatDistance(result.radius) }}
          <span v-if="result.truncated"> · closest {{ allPlaces.length }} shown</span>
        </p>
        <p v-else-if="loading" class="results-sub">Asking OpenStreetMap about this area</p>
      </div>

      <label class="sort">
        <span class="sr-only">Sort by</span>
        <select v-model="sortMode">
          <option value="distance">Nearest first</option>
          <option value="name">A → Z</option>
          <option value="category">By category</option>
        </select>
      </label>
    </header>

    <div v-if="grouped.length && !loading" class="summary-chips" role="group" aria-label="Narrow by category">
      <button
        v-for="group in grouped"
        :key="group.categoryId"
        type="button"
        class="tag tag-button"
        :class="[`tag-${group.categoryId}`, { dim: filterCategory && filterCategory !== group.categoryId }]"
        :aria-pressed="filterCategory === group.categoryId"
        @click="toggleFilter(group.categoryId)"
      >
        <span aria-hidden="true">{{ iconFor(group.categoryId) }}</span>
        {{ group.label }} <b>{{ group.total }}</b>
      </button>
    </div>

    <p v-if="partialNotice" class="notice warn">{{ partialNotice }}</p>
    <p v-if="fillingIn && !loading" class="notice subtle">{{ fillingIn }}</p>

    <p v-if="diagnostics && !diagnostics.liveFetch && !loading" class="notice subtle cache-note">
      <span>From the local database · {{ diagnostics.cachedCount }} places known here</span>
      <button type="button" class="link-btn" @click="emit('retry-live')">Refresh from OpenStreetMap</button>
    </p>

    <!-- Skeleton rows: the cold search takes 6–14 s and a bare label made it
         look frozen. -->
    <ul v-if="loading" class="place-list skeleton-list" aria-hidden="true">
      <li v-for="n in 7" :key="n" class="place-row skeleton">
        <span class="place-avatar shimmer"></span>
        <div class="place-body">
          <span class="shimmer line w70"></span>
          <span class="shimmer line w40"></span>
          <span class="shimmer line w85"></span>
        </div>
        <div class="place-distance">
          <span class="shimmer line w30"></span>
        </div>
      </li>
    </ul>

    <ul v-else-if="places.length" ref="listElement" class="place-list">
      <li
        v-for="(place, index) in places"
        :key="place.id"
        class="place-row"
        :class="{ active: place.id === selectedPlaceId, hovered: place.id === hoveredPlaceId }"
        :data-place-id="place.id"
        role="button"
        tabindex="0"
        :style="{ '--i': Math.min(index, 12) }"
        @click="emit('select-place', place)"
        @keydown="onRowKeydown($event, place)"
        @mouseenter="emit('hover-place', place.id)"
        @mouseleave="emit('hover-place', '')"
      >
        <span class="place-avatar" :style="{ '--pin': colorFor(place.categoryId) }" aria-hidden="true">
          {{ iconFor(place.categoryId) }}
        </span>

        <div class="place-body">
          <strong class="place-name">{{ displayName(place) }}</strong>
          <span class="place-type">
            {{ typeLabel(place) }}
            <template v-if="place.address"> · {{ place.address }}</template>
          </span>
          <span class="place-travel">
            <span title="On foot">🚶 {{ walkingMinutes(place.distance) }} min</span>
            <span title="By motorbike or car">🛵 {{ ridingMinutes(place.distance) }} min</span>
          </span>
        </div>

        <div class="place-distance">
          <strong>{{ formatDistance(place.distance) }}</strong>
          <button
            type="button"
            class="row-locate"
            title="Show on map"
            aria-label="Show on map"
            @click.stop="emit('preview-place', place)"
          >
            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7m0 9.5a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5"/></svg>
          </button>
        </div>
      </li>
    </ul>

    <div v-else-if="result" class="empty">
      <span class="empty-glyph" aria-hidden="true">🗺️</span>
      <p><strong>Nothing found in this radius.</strong></p>
      <ul>
        <li>Try a bigger radius — drag the ring's handle on the map.</li>
        <li>Select more categories; a single category in a quiet area is often empty.</li>
        <li v-if="partialNotice">Some upstream queries failed; try refreshing.</li>
      </ul>
      <button type="button" class="link-btn" @click="emit('retry-live')">Refresh from OpenStreetMap</button>
    </div>
  </section>
</template>
