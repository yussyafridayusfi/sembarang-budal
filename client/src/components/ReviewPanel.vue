<script setup>
import { computed, ref, watch } from "vue";
import { searchLocations } from "../services/api";
import { colorFor, formatDistance, iconFor, secondaryLine } from "../lib/categories";

/**
 * Find & review: one place, everything people have said about it.
 *
 * Explore answers "what is around here"; this answers "is this place any
 * good". The search is the same as the centre search, but picking a result
 * opens a review page in the panel rather than a search around it: rating
 * histogram, Google's own highlights and topics, the pros / cons / best-menu
 * findings counted from the review texts, and every review text we hold -
 * which is the eight the public listing carries, or five from the Places API.
 * That cap is said on the page, with a link to the rest on Google Maps.
 */
const props = defineProps({
  /** The map's view centre, to bias the search. */
  mapCenter: { type: Object, default: null },
  /** The chosen place, once there is one. */
  place: { type: Object, default: null },
  details: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  error: { type: String, default: "" }
});

const emit = defineEmits(["pick", "clear", "open-details"]);

/* ---------------------------------------------------------------- search */

const query = ref("");
const suggestions = ref([]);
const searching = ref(false);
const searched = ref(false);
const suggestError = ref("");
const showList = ref(false);
const activeIndex = ref(-1);
const inputElement = ref(null);

let debounceTimer = null;
let controller = null;

const listOpen = computed(
  () => showList.value && query.value.trim().length >= 2 && (searching.value || searched.value)
);

function onInput(event) {
  query.value = event.target.value;
  activeIndex.value = -1;
  clearTimeout(debounceTimer);
  controller?.abort();

  const text = query.value.trim();

  if (text.length < 2) {
    suggestions.value = [];
    searched.value = false;
    searching.value = false;
    return;
  }

  searching.value = true;
  showList.value = true;

  debounceTimer = setTimeout(async () => {
    const request = new AbortController();
    controller = request;

    try {
      const response = await searchLocations(text, request.signal, props.mapCenter);
      suggestions.value = response.suggestions || [];
      suggestError.value = "";
      searched.value = true;
      activeIndex.value = suggestions.value.length ? 0 : -1;
    } catch (err) {
      if (err.name !== "AbortError") {
        suggestions.value = [];
        suggestError.value = err.message;
        searched.value = true;
      }
    } finally {
      if (controller === request) {
        searching.value = false;
      }
    }
  }, 350);
}

function onKeydown(event) {
  if (!listOpen.value || !suggestions.value.length) {
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    activeIndex.value = (activeIndex.value + 1) % suggestions.value.length;
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    activeIndex.value = (activeIndex.value - 1 + suggestions.value.length) % suggestions.value.length;
  } else if (event.key === "Enter" && activeIndex.value >= 0) {
    event.preventDefault();
    choose(suggestions.value[activeIndex.value]);
  } else if (event.key === "Escape") {
    showList.value = false;
    inputElement.value?.blur();
  }
}

function choose(suggestion) {
  query.value = suggestion.name || suggestion.displayName || "";
  suggestions.value = [];
  searched.value = false;
  showList.value = false;
  emit("pick", suggestion);
}

function changePlace() {
  query.value = "";
  emit("clear");
  // Let the search box come back before focusing it.
  setTimeout(() => inputElement.value?.focus(), 0);
}

watch(
  () => props.place,
  (place) => {
    if (place && !query.value) {
      query.value = place.name || "";
    }
  }
);

/* --------------------------------------------------------------- reviews */

const sortMode = ref("newest");

const insights = computed(() => props.details?.insights || null);
const hasInsights = computed(() => (insights.value?.basedOn || 0) > 0);

const histogramRows = computed(() => {
  const counts = props.details?.ratingHistogram;

  if (!counts?.length) {
    return [];
  }

  const total = counts.reduce((sum, count) => sum + count, 0) || 1;
  return [5, 4, 3, 2, 1].map((star) => ({ star, count: counts[star - 1], pct: Math.round((counts[star - 1] / total) * 100) }));
});

const reviews = computed(() => {
  const list = [...(props.details?.reviews || [])];

  if (sortMode.value === "highest") {
    return list.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  }

  if (sortMode.value === "lowest") {
    return list.sort((a, b) => (a.rating || 0) - (b.rating || 0));
  }

  return list.sort((a, b) => String(b.publishTime || "").localeCompare(String(a.publishTime || "")));
});

/**
 * One sentence that says what the counts say - and only that. "Reviewers
 * praise tasty food and friendly staff (3 and 2 of 8); the recurring
 * complaint is slow service (2 of 8)." Nothing is stated that was not counted.
 */
const summaryLine = computed(() => {
  const data = insights.value;

  if (!data?.basedOn) {
    return "";
  }

  const name = (theme) => theme.label.toLowerCase();
  const praise = (data.praise || []).slice(0, 2);
  const complaints = (data.complaints || []).slice(0, 2);
  const parts = [];

  if (praise.length) {
    parts.push(
      `Reviewers praise ${praise.map(name).join(" and ")} (${praise.map((theme) => theme.mentions).join(" and ")} of ${data.basedOn})`
    );
  }

  if (complaints.length) {
    parts.push(
      `${praise.length ? "the recurring complaint is" : "The recurring complaint is"} ${complaints.map(name).join(" and ")} (${complaints.map((theme) => theme.mentions).join(" and ")} of ${data.basedOn})`
    );
  }

  if (!parts.length) {
    return "";
  }

  return `${parts.join("; ")}.`;
});

/** The glance cells that actually have a value, as one compact list. */
const knownFacts = computed(() => {
  const attributes = props.details?.attributes || {};

  return [
    ["⏱️", "Waiting time", attributes.waitingTime],
    ["👥", "Crowd", attributes.crowd],
    ["🚗", "Parking", attributes.parking],
    ["💳", "Payment", attributes.payment],
    ["🎭", "Atmosphere", attributes.atmosphere]
  ]
    .filter(([, , cell]) => cell)
    .map(([icon, label, cell]) => ({ icon, label, value: cell.value, note: cell.note }));
});

const reviewsOnGoogle = computed(() => props.details?.links?.googleMaps || "");

function formatCount(value) {
  return typeof value === "number" ? value.toLocaleString("id-ID") : "";
}

function stars(rating) {
  const full = Math.round(Number(rating) || 0);
  return "★".repeat(full) + "☆".repeat(Math.max(0, 5 - full));
}
</script>

<template>
  <section class="panel review-panel">
    <header class="panel-header">
      <h2>Find &amp; review</h2>
      <p class="panel-sub">Look up one place and read what people say about it before you go.</p>
    </header>

    <!-- -------------------------------------------------------------- Search -->
    <div v-if="!place" class="field">
      <div class="combo search-combo" :class="{ open: listOpen }">
        <span class="search-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14"/></svg>
        </span>
        <input
          id="review-search"
          ref="inputElement"
          type="text"
          role="combobox"
          aria-label="Place to review"
          :aria-expanded="Boolean(listOpen)"
          placeholder="Name of a place, a Maps link, or lat,lng"
          autocomplete="off"
          :value="query"
          @input="onInput"
          @keydown="onKeydown"
          @focus="showList = true"
          @blur="showList = false"
        />

        <ul v-if="listOpen" class="combo-list" role="listbox">
          <li v-if="searching" class="combo-status"><span class="spinner" aria-hidden="true"></span> Searching…</li>
          <li v-else-if="suggestError" class="combo-status combo-error">{{ suggestError }}</li>
          <li v-else-if="!suggestions.length" class="combo-status">
            No places match “{{ query.trim() }}”. Try adding a city, or paste a Google Maps link.
          </li>
          <li v-for="(suggestion, index) in suggestions" :key="`${suggestion.osmType}${suggestion.osmId}${suggestion.lat}`" role="option" :aria-selected="index === activeIndex">
            <button
              type="button"
              :class="{ active: index === activeIndex }"
              @mousedown.prevent="choose(suggestion)"
              @mousemove="activeIndex = index"
            >
              <span class="suggest-glyph" aria-hidden="true">📍</span>
              <strong>
                {{ suggestion.name || suggestion.displayName }}
                <em v-if="suggestion.distance" class="suggest-distance">{{ formatDistance(suggestion.distance) }}</em>
              </strong>
              <span v-if="secondaryLine(suggestion)">{{ secondaryLine(suggestion) }}</span>
            </button>
          </li>
        </ul>
      </div>
    </div>

    <section v-if="!place" class="welcome">
      <h2>How it works</h2>
      <ol>
        <li><strong>Search</strong> — type the place's name, paste a Google Maps link, or a lat,lng.</li>
        <li><strong>Pick it</strong> — the map jumps to it and the reviews load.</li>
        <li><strong>Read</strong> — ratings, what reviewers praise and complain about, the best dishes, and every review text we can get.</li>
      </ol>
    </section>

    <!-- ----------------------------------------------------------- The place -->
    <template v-else>
      <article class="review-place" :style="{ '--pin': colorFor(details?.categoryId || place.categoryId) }">
        <span class="place-avatar" :style="{ '--pin': colorFor(details?.categoryId || place.categoryId) }" aria-hidden="true">
          {{ iconFor(details?.categoryId || place.categoryId) }}
        </span>
        <div class="review-place-body">
          <h3>{{ details?.name || place.name }}</h3>
          <p class="review-place-meta">
            <span v-if="details?.categoryLabel" :class="`tag tag-${details.categoryId}`">{{ details.categoryLabel }}</span>
            <span v-if="details?.google?.categoryLabel" class="muted">{{ details.google.categoryLabel }}</span>
          </p>
          <p class="review-place-address muted">{{ details?.address || place.address || "" }}</p>
        </div>
        <button type="button" class="link-btn review-change" @click="changePlace">Change</button>
      </article>

      <div v-if="details" class="modal-headline review-headline">
        <span v-if="details.rating !== null" class="headline-chip rating">
          <strong>{{ details.rating.toFixed(1) }}</strong>
          <span class="stars" aria-hidden="true">{{ stars(details.rating) }}</span>
          <span v-if="details.reviewCount !== null" class="muted">({{ formatCount(details.reviewCount) }})</span>
        </span>
        <span v-if="details.priceRange || details.priceLevel" class="headline-chip">{{ details.priceRange || details.priceLevel }}</span>
        <span v-if="details.openNow === true" class="headline-chip open"><span class="live-dot" aria-hidden="true"></span>{{ details.statusText || "Open now" }}</span>
        <span v-else-if="details.openNow === false" class="headline-chip closed">{{ details.statusText || "Closed now" }}</span>
      </div>

      <div class="review-actions">
        <button type="button" class="quick-btn primary" @click="emit('open-details')">Full details</button>
        <a v-if="reviewsOnGoogle" :href="reviewsOnGoogle" target="_blank" rel="noopener noreferrer" class="quick-btn">Google Maps ↗</a>
      </div>

      <!-- Skeleton: same shape as what loads. -->
      <div v-if="loading" class="review-loading" aria-busy="true">
        <span class="shimmer line w60"></span>
        <span class="shimmer block h56"></span>
        <span class="shimmer line w85"></span>
        <span class="shimmer line w70"></span>
        <span class="shimmer block h56"></span>
      </div>

      <p v-else-if="error" class="notice error" role="alert">{{ error }}</p>

      <template v-else-if="details">
        <!-- ---------------------------------------------------------- Summary -->
        <section class="modal-section">
          <h3>
            Summary
            <span class="section-note">
              <template v-if="hasInsights">from {{ insights.basedOn }} review texts</template>
              <template v-if="details.reviewCount !== null"> · {{ formatCount(details.reviewCount) }} ratings on Google</template>
            </span>
          </h3>

          <p v-if="insights?.summary" class="review-summary">{{ insights.summary }}</p>
          <p v-if="summaryLine" class="review-summary counted">{{ summaryLine }}</p>

          <div v-if="histogramRows.length || details.reviewTopics?.length" class="review-overview">
            <ul v-if="histogramRows.length" class="histogram" aria-label="Rating distribution">
              <li v-for="row in histogramRows" :key="row.star">
                <span class="h-star">{{ row.star }}★</span>
                <span class="h-track"><i :style="{ width: `${row.pct}%` }"></i></span>
                <span class="h-count">{{ formatCount(row.count) }}</span>
              </li>
            </ul>
            <div v-if="details.reviewTopics?.length" class="topic-chips">
              <span class="pane-title">Reviewers mention</span>
              <span v-for="topic in details.reviewTopics" :key="topic.label" class="attr-chip">{{ topic.label }} <b>{{ topic.count }}</b></span>
            </div>
          </div>

          <blockquote v-for="snippet in details.reviewSnippets || []" :key="snippet" class="review-quote highlight">
            “{{ snippet }}”<cite> — Google Maps highlight</cite>
          </blockquote>

          <div v-if="hasInsights" class="review-columns">
            <div>
              <h4 class="pane-title">👍 Praised</h4>
              <ul v-if="insights.praise.length" class="theme-list good">
                <li v-for="theme in insights.praise" :key="theme.label">
                  <span>{{ theme.label }}</span>
                  <span class="mentions">{{ theme.mentions }} of {{ insights.basedOn }}</span>
                </li>
              </ul>
              <p v-else class="muted">No consistent praise in the texts we have.</p>
            </div>
            <div>
              <h4 class="pane-title">⚠️ Complaints</h4>
              <ul v-if="insights.complaints.length" class="theme-list bad">
                <li v-for="theme in insights.complaints" :key="theme.label">
                  <span>{{ theme.label }}</span>
                  <span class="mentions">{{ theme.mentions }} of {{ insights.basedOn }}</span>
                </li>
              </ul>
              <p v-else class="muted">No recurring complaint in the texts we have.</p>
            </div>
          </div>

          <div v-if="hasInsights && insights.bestMenu.length" class="review-menu">
            <h4 class="pane-title">🍽️ Dishes reviewers name</h4>
            <ol class="menu-list">
              <li v-for="item in insights.bestMenu" :key="item.item">{{ item.item }}</li>
            </ol>
          </div>

          <ul v-if="knownFacts.length" class="review-facts">
            <li v-for="fact in knownFacts" :key="fact.label" :title="fact.note || ''">
              <span aria-hidden="true">{{ fact.icon }}</span>
              <span class="review-fact-label">{{ fact.label }}</span>
              <span class="review-fact-value">{{ fact.value }}</span>
            </li>
          </ul>

          <p v-if="!hasInsights && !histogramRows.length && !details.reviewSnippets?.length" class="modal-unknown">
            <template v-if="details.rating !== null">
              Google shows a {{ details.rating.toFixed(1) }} rating<template v-if="details.reviewCount !== null"> from {{ formatCount(details.reviewCount) }} people</template>, but no review text came with it.
            </template>
            <template v-else>No ratings or reviews could be found for this place.</template>
            <template v-if="details.limitations?.length"> {{ details.limitations[0] }}</template>
          </p>
        </section>

        <!-- ---------------------------------------------------------- Reviews -->
        <section v-if="details.reviews?.length" class="modal-section">
          <h3>
            Reviews
            <span class="section-note">{{ details.reviews.length }} with text</span>
          </h3>

          <div class="review-sort" role="group" aria-label="Sort reviews">
            <button v-for="option in [['newest', 'Newest'], ['highest', 'Highest'], ['lowest', 'Lowest']]" :key="option[0]" type="button" :class="{ active: sortMode === option[0] }" :aria-pressed="sortMode === option[0]" @click="sortMode = option[0]">
              {{ option[1] }}
            </button>
          </div>

          <ul class="modal-reviews review-list">
            <li v-for="review in reviews" :key="`${review.author}-${review.publishTime || review.relativeTime}`">
              <p class="review-head">
                <strong>{{ review.author }}</strong>
                <span><template v-if="review.rating"><span class="stars">{{ stars(review.rating) }}</span> · </template>{{ review.relativeTime }}</span>
              </p>
              <p class="review-text">{{ review.text }}</p>
              <div v-if="review.photos?.length" class="review-photos">
                <img v-for="photo in review.photos" :key="photo" :src="photo" :alt="`Photo by ${review.author}`" loading="lazy" referrerpolicy="no-referrer" />
              </div>
              <p v-if="review.ownerReply" class="owner-reply"><strong>Owner reply</strong> {{ review.ownerReply }}</p>
            </li>
          </ul>

          <p class="review-note muted">
            <template v-if="details.reviewCount !== null && details.reviewCount > details.reviews.length">
              These are the {{ details.reviews.length }} review texts Google's public listing carries;
              the other {{ formatCount(details.reviewCount - details.reviews.length) }} are
              <a :href="reviewsOnGoogle" target="_blank" rel="noopener noreferrer">on Google Maps</a>.
            </template>
            <template v-else>Every review text we could find is above.</template>
          </p>
        </section>
      </template>
    </template>
  </section>
</template>
