<script setup>
import { computed, nextTick, ref, watch } from "vue";
import {
  QUICK_FILTERS,
  colorFor,
  displayName,
  formatDistance,
  iconFor,
  phoneOf,
  ridingMinutes,
  typeLabel,
  walkingMinutes
} from "../lib/categories";

const props = defineProps({
  result: { type: Object, default: null },
  categories: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  /** A quiet re-fetch is running behind the list that is already shown. */
  refreshing: { type: Boolean, default: false },
  selectedPlaceId: { type: String, default: "" },
  hoveredPlaceId: { type: String, default: "" }
});

const emit = defineEmits(["select-place", "preview-place", "hover-place", "retry-live"]);

const sortMode = ref("distance");
/** A quick client-side narrowing by category, on top of the server search. */
const filterCategory = ref("");
/** A finer cut inside a category: "tambal ban", not "vehicle repair". */
const quickFilter = ref("");
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

  if (activeQuickFilter.value) {
    list = list.filter(activeQuickFilter.value.match);
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

/**
 * Quick filters for the categories present in this result, each with how many
 * places it would keep; an empty one is not offered.
 */
const quickFilters = computed(() =>
  Object.entries(QUICK_FILTERS)
    .filter(([categoryId]) => allPlaces.value.some((place) => place.categoryId === categoryId))
    .flatMap(([categoryId, filters]) =>
      filters.map((filter) => ({
        ...filter,
        key: `${categoryId}:${filter.id}`,
        categoryId,
        total: allPlaces.value.filter((place) => place.categoryId === categoryId && filter.match(place)).length
      }))
    )
    .filter((filter) => filter.total > 0)
);

const activeQuickFilter = computed(() => quickFilters.value.find((filter) => filter.key === quickFilter.value) || null);

// A new result set may no longer contain the filtered category or quick cut.
watch(allPlaces, () => {
  if (filterCategory.value && !allPlaces.value.some((place) => place.categoryId === filterCategory.value)) {
    filterCategory.value = "";
  }

  if (quickFilter.value && !quickFilters.value.some((filter) => filter.key === quickFilter.value)) {
    quickFilter.value = "";
  }
});

function toggleFilter(categoryId) {
  filterCategory.value = filterCategory.value === categoryId ? "" : categoryId;

  // A quick cut belongs to one category; leaving that category drops it.
  if (activeQuickFilter.value && filterCategory.value && activeQuickFilter.value.categoryId !== filterCategory.value) {
    quickFilter.value = "";
  }
}

function toggleQuickFilter(filter) {
  if (quickFilter.value === filter.key) {
    quickFilter.value = "";
    return;
  }

  quickFilter.value = filter.key;
  // The cut implies its category.
  filterCategory.value = filter.categoryId;
}

function telHref(place) {
  const phone = phoneOf(place);
  return phone ? `tel:${phone.replace(/[^\d+]/g, "")}` : "";
}

/**
 * Whether more places may still arrive: an upstream query failed or the
 * long tail is being collected in the background. The app retries on its
 * own (see App.vue); the list only shows that it is still looking, never the
 * plumbing behind it.
 */
const stillLooking = computed(() => {
  const diag = props.result?.diagnostics;

  return Boolean(
    diag?.liveFetch && ((diag.failures || []).length || diag.backgroundQueued || diag.pendingJobs > 0)
  );
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

  if (filterCategory.value || activeQuickFilter.value) {
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

      <div class="results-tools">
        <span v-if="refreshing || (stillLooking && !loading)" class="results-updating" role="status">
          <span class="spinner" aria-hidden="true"></span>
          {{ refreshing ? "Updating…" : "Still looking…" }}
        </span>
        <button
          v-if="result && !loading"
          type="button"
          class="icon-round small"
          title="Refresh results"
          aria-label="Refresh results"
          :disabled="refreshing"
          @click="emit('retry-live')"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4z"/></svg>
        </button>
        <label class="sort">
          <span class="sr-only">Sort by</span>
          <select v-model="sortMode">
            <option value="distance">Nearest first</option>
            <option value="name">A → Z</option>
            <option value="category">By category</option>
          </select>
        </label>
      </div>
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


    <div v-if="quickFilters.length && !loading" class="quick-filters" role="group" aria-label="Find">
      <span class="quick-filters-label">Find</span>
      <button
        v-for="filter in quickFilters"
        :key="filter.key"
        type="button"
        class="quick-filter"
        :class="{ active: quickFilter === filter.key }"
        :style="{ '--pin': colorFor(filter.categoryId) }"
        :aria-pressed="quickFilter === filter.key"
        @click="toggleQuickFilter(filter)"
      >
        <span aria-hidden="true">{{ filter.icon }}</span>
        {{ filter.label }} <b>{{ filter.total }}</b>
      </button>
    </div>

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
          <a
            v-if="telHref(place)"
            :href="telHref(place)"
            class="row-locate row-call"
            :title="`Call ${phoneOf(place)}`"
            :aria-label="`Call ${phoneOf(place)}`"
            @click.stop
          >
            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.01-.24c1.12.37 2.33.57 3.58.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1.02z"/></svg>
          </a>
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
        <li v-if="stillLooking">Still looking — more may appear in a moment.</li>
      </ul>
      <button type="button" class="link-btn" @click="emit('retry-live')">Search again</button>
    </div>
  </section>
</template>
