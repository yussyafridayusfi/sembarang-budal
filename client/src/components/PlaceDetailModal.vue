<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { colorFor, formatDistance, iconFor, ridingMinutes, walkingMinutes } from "../lib/categories";
import { fetchPlaceVideos } from "../services/api";

const props = defineProps({
  open: { type: Boolean, default: false },
  place: { type: Object, default: null },
  details: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  error: { type: String, default: "" }
});

const emit = defineEmits(["close"]);

const copied = ref("");
const imageIndex = ref(0);
const hoursOpen = ref(false);
const reviewTab = ref("pros");
const showAllReviews = ref(false);

// Videos load after the details, per place, and are kept for the session.
const videos = ref([]);
const videoLinks = ref([]);
const videosLoading = ref(false);
const videosError = ref("");
const videosCache = new Map();
let videosController = null;

/** The town or district from the address, to steer the video search. */
function areaFromAddress(address) {
  const parts = String(address || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const kecamatan = parts.find((part) => /^Kec\.|^Kecamatan/i.test(part));
  const kabupaten = parts.find((part) => /^Kabupaten|^Kota|Surabaya|Sidoarjo/i.test(part));

  return [kecamatan, kabupaten]
    .filter(Boolean)
    .map((part) => part.replace(/^(Kec\.|Kecamatan|Kabupaten|Kota)\s*/i, "").replace(/\s+\d{5}$/, ""))
    .filter((part, index, list) => part && list.indexOf(part) === index)
    .join(" ");
}

async function loadVideos(details) {
  videosController?.abort();
  videos.value = [];
  videoLinks.value = [];
  videosError.value = "";

  const name = details?.name;

  if (!name || details.unnamed) {
    videosLoading.value = false;
    return;
  }

  if (videosCache.has(details.id)) {
    Object.assign(videos, { value: videosCache.get(details.id).videos });
    videoLinks.value = videosCache.get(details.id).links;
    videosLoading.value = false;
    return;
  }

  videosController = new AbortController();
  videosLoading.value = true;

  try {
    const payload = await fetchPlaceVideos(name, areaFromAddress(details.address), videosController.signal);
    videosCache.set(details.id, payload);
    videos.value = payload.videos || [];
    videoLinks.value = payload.links || [];
  } catch (err) {
    if (err.name !== "AbortError") {
      videosError.value = "Video search is unavailable right now.";
      videoLinks.value = [];
    }
  } finally {
    videosLoading.value = false;
  }
}

watch(() => props.details, (details) => loadVideos(details));
onBeforeUnmount(() => videosController?.abort());

/** Google's day indexes: 1 = Senin … 7 = Minggu. */
const DAY_SHORT = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];
const todayIndex = new Date().getDay() || 7;
const popularDay = ref(todayIndex);
const sheetElement = ref(null);
const closeButton = ref(null);

/** Whatever had focus before the sheet opened gets it back on close. */
let previouslyFocused = null;

watch(
  () => props.details,
  () => {
    imageIndex.value = 0;
    hoursOpen.value = false;
    reviewTab.value = "pros";
    showAllReviews.value = false;
    popularDay.value = todayIndex;
  }
);

function onKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
    return;
  }

  if (event.key === "ArrowLeft" && images.value.length > 1 && !isTyping(event)) {
    nextImage(-1);
  } else if (event.key === "ArrowRight" && images.value.length > 1 && !isTyping(event)) {
    nextImage(1);
  } else if (event.key === "Tab") {
    trapFocus(event);
  }
}

function isTyping(event) {
  return /^(input|textarea|select)$/i.test(event.target?.tagName || "");
}

function trapFocus(event) {
  const focusable = sheetElement.value?.querySelectorAll(
    'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );

  if (!focusable?.length) {
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      previouslyFocused = document.activeElement;
      document.addEventListener("keydown", onKeydown);
      await nextTick();
      closeButton.value?.focus({ preventScroll: true });
    } else {
      document.removeEventListener("keydown", onKeydown);
      previouslyFocused?.focus?.({ preventScroll: true });
      previouslyFocused = null;
    }
  }
);

onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));

const images = computed(() => props.details?.images || []);
const activeImage = computed(() => images.value[imageIndex.value] || null);

function nextImage(step) {
  const count = images.value.length;

  if (!count) {
    return;
  }

  imageIndex.value = (imageIndex.value + step + count) % count;
}

const categoryId = computed(() => props.details?.categoryId || props.place?.categoryId || "other");

const contactEntries = computed(() => {
  const contacts = props.details?.contacts || {};

  return [
    { key: "phone", label: "Phone", value: contacts.phone, href: contacts.phone ? `tel:${contacts.phone.replace(/[^\d+]/g, "")}` : "", source: props.details?.provenance?.phone },
    { key: "website", label: "Website", value: contacts.website, href: contacts.website, source: props.details?.provenance?.website },
    { key: "instagram", label: "Instagram", value: contacts.instagram, href: contacts.instagram, source: "osm" },
    { key: "facebook", label: "Facebook", value: contacts.facebook, href: contacts.facebook, source: "osm" },
    { key: "email", label: "Email", value: contacts.email, href: contacts.email ? `mailto:${contacts.email}` : "", source: "osm" }
  ].filter((entry) => entry.value);
});

/** Human labels for where a value came from - printed beside every value. */
const SOURCE_LABELS = {
  "google-places": "Google Places API",
  "google-maps": "Google Maps",
  google: "Google",
  osm: "OpenStreetMap",
  reviews: "from reviews"
};

function sourceLabel(source) {
  return SOURCE_LABELS[source] || source || "";
}

/** Today's line in a weekly hours table, matched by Indonesian or English day. */
const todayLine = computed(() => {
  const lines = props.details?.openingHours || [];

  if (lines.length < 7) {
    return "";
  }

  const dayNames = [
    ["minggu", "sunday"],
    ["senin", "monday"],
    ["selasa", "tuesday"],
    ["rabu", "wednesday"],
    ["kamis", "thursday"],
    ["jumat", "friday"],
    ["sabtu", "saturday"]
  ][new Date().getDay()];

  return lines.find((line) => dayNames.some((day) => line.toLowerCase().startsWith(day))) || "";
});

const insights = computed(() => props.details?.insights || null);
const hasInsights = computed(() => (insights.value?.basedOn || 0) > 0);

// Popular times: one day at a time, today first.
const popularDays = computed(() => props.details?.popularTimes?.days || []);
const popularSelected = computed(
  () => popularDays.value.find((day) => day.dayIndex === popularDay.value) || popularDays.value[0] || null
);
const popularMax = computed(() => Math.max(1, ...(popularSelected.value?.hours.map((hour) => hour.busy) || [1])));
const currentHour = new Date().getHours();

/** 5★ → 1★ rows with share of all ratings, from the listing's histogram. */
const histogramRows = computed(() => {
  const counts = props.details?.ratingHistogram;

  if (!counts?.length) {
    return [];
  }

  const total = counts.reduce((sum, count) => sum + count, 0) || 1;
  return [5, 4, 3, 2, 1].map((star) => ({ star, count: counts[star - 1], pct: Math.round((counts[star - 1] / total) * 100) }));
});

const priceVotesTotal = computed(() => (props.details?.priceVotes || []).reduce((sum, vote) => sum + vote.votes, 0));

/** Google's price bands as shares of everyone who reported a spend. */
const priceBands = computed(() => {
  const total = priceVotesTotal.value;

  if (!total) {
    return [];
  }

  return (props.details?.priceVotes || []).map((vote) => ({
    label: vote.label,
    votes: vote.votes,
    pct: Math.round((vote.votes / total) * 100)
  }));
});

/** The band most people reported - the answer to "what will this cost me". */
const topPriceBand = computed(() =>
  priceBands.value.reduce((best, band) => (!best || band.votes > best.votes ? band : best), null)
);

const hasReviewSection = computed(
  () =>
    hasInsights.value ||
    Boolean(insights.value?.summary) ||
    histogramRows.value.length > 0 ||
    (props.details?.reviewTopics?.length || 0) > 0 ||
    (props.details?.reviewSnippets?.length || 0) > 0
);

function hourLabel(hour) {
  return String(hour).padStart(2, "0");
}

const attributeRows = computed(() => {
  const attributes = props.details?.attributes || {};

  return [
    { key: "atmosphere", icon: "🎭", label: "Atmosphere", cell: attributes.atmosphere },
    { key: "parking", icon: "🚗", label: "Parking", cell: attributes.parking },
    { key: "waitingTime", icon: "⏱️", label: "Waiting time", cell: attributes.waitingTime },
    { key: "crowd", icon: "👥", label: "Crowd", cell: attributes.crowd },
    { key: "location", icon: "📍", label: "Location", cell: attributes.location },
    { key: "payment", icon: "💳", label: "Payment", cell: attributes.payment },
    { key: "popularity", icon: "🔥", label: "Popularity", cell: attributes.popularity }
  ];
});

const knownAttributeCount = computed(() => attributeRows.value.filter((row) => row.cell).length);

const visibleReviews = computed(() => {
  const reviews = props.details?.reviews || [];
  return showAllReviews.value ? reviews : reviews.slice(0, 2);
});

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = label;
    setTimeout(() => {
      copied.value = "";
    }, 1800);
  } catch {
    copied.value = "";
  }
}

async function share() {
  const name = props.details?.name || props.place?.name || "This place";
  const url = props.details?.links?.googleMaps || window.location.href;

  if (navigator.share) {
    try {
      await navigator.share({ title: name, text: `${name} — found with Sembarang Budal`, url });
      return;
    } catch {
      // Cancelled or unsupported - fall through to the clipboard.
    }
  }

  copy(url, "share");
}

function formatCount(value) {
  return typeof value === "number" ? value.toLocaleString("id-ID") : "";
}

function stars(rating) {
  const full = Math.round(Number(rating) || 0);
  return "★".repeat(full) + "☆".repeat(Math.max(0, 5 - full));
}

const title = computed(() => {
  if (props.details?.unnamed) {
    return `Unnamed ${(props.details.type || "place").replace(/_/g, " ")}`;
  }

  return props.details?.name || props.place?.name || "Place";
});
</script>

<template>
  <Teleport to="body">
    <transition name="sheet">
      <div v-if="open" class="modal-backdrop" @click.self="emit('close')">
        <article
          ref="sheetElement"
          class="modal"
          role="dialog"
          aria-modal="true"
          :aria-label="title"
          :style="{ '--pin': colorFor(categoryId) }"
        >
          <div class="sheet-grip" aria-hidden="true"></div>

          <header class="modal-header">
            <span class="modal-avatar" aria-hidden="true">{{ iconFor(categoryId) }}</span>

            <div class="modal-title">
              <h2>{{ title }}</h2>
              <p v-if="details?.unnamed" class="modal-type">Shown by its street: {{ details.name }}</p>
              <p class="modal-meta">
                <span v-if="details?.categoryLabel" :class="`tag tag-${details.categoryId}`">{{ details.categoryLabel }}</span>
                <span v-if="details?.google?.categoryLabel" class="modal-type">{{ details.google.categoryLabel }}</span>
                <span v-else class="modal-type">{{ (details?.type || place?.tagValue || "").replace(/_/g, " ") }}</span>
              </p>
            </div>

            <div class="modal-actions">
              <button type="button" class="icon-round" title="Share" aria-label="Share" @click="share">
                <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92"/></svg>
              </button>
              <button ref="closeButton" type="button" class="icon-round" aria-label="Close" title="Close (Esc)" @click="emit('close')">
                <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
              </button>
            </div>
          </header>

          <span v-if="copied === 'share'" class="toast">Link copied</span>

          <!-- Headline strip: rating · reviews · price · open now · distance.
               Each value names its source; anything unknown is simply absent. -->
          <div v-if="details" class="modal-headline">
            <span v-if="details.rating !== null" class="headline-chip rating" :title="`Rating from ${sourceLabel(details.provenance?.rating)}`">
              <strong>{{ details.rating.toFixed(1) }}</strong>
              <span class="stars" aria-hidden="true">{{ stars(details.rating) }}</span>
              <span v-if="details.reviewCount !== null" class="muted">({{ formatCount(details.reviewCount) }})</span>
            </span>
            <span v-if="details.priceRange || details.priceLevel" class="headline-chip" :title="`Price from ${sourceLabel(details.provenance?.price)}`">
              {{ details.priceRange || details.priceLevel }}
            </span>
            <span v-if="details.openNow === true" class="headline-chip open">
              <span class="live-dot" aria-hidden="true"></span>{{ details.statusText || "Open now" }}
            </span>
            <span v-else-if="details.openNow === false" class="headline-chip closed">
              {{ details.statusText || "Closed now" }}
            </span>
            <span v-if="details.popularTimes?.liveLabel" class="headline-chip" title="Live busyness from Google Maps">
              📊 {{ details.popularTimes.liveLabel }}
            </span>
            <span v-if="place?.distance" class="headline-chip" title="From the search centre">
              {{ formatDistance(place.distance) }} · 🚶 {{ walkingMinutes(place.distance) }} min · 🛵 {{ ridingMinutes(place.distance) }} min
            </span>
          </div>

          <!-- Skeleton while the details load: same shape as the real body. -->
          <div v-if="loading" class="modal-body" aria-busy="true">
            <div class="shimmer block h180"></div>
            <div class="glance-grid skeleton-grid">
              <span v-for="n in 4" :key="n" class="shimmer block h56"></span>
            </div>
            <span class="shimmer line w60"></span>
            <span class="shimmer line w85"></span>
            <span class="shimmer line w40"></span>
          </div>

          <p v-else-if="error" class="modal-status error">{{ error }}</p>

          <div v-else-if="details" class="modal-body">
            <!-- ---------------------------------------------------------- Photos -->
            <figure v-if="activeImage" class="modal-figure">
              <div class="figure-stage">
                <img :src="activeImage.url" :alt="activeImage.alt" loading="eager" referrerpolicy="no-referrer" />
                <button v-if="images.length > 1" type="button" class="figure-nav prev" aria-label="Previous photo" @click="nextImage(-1)">‹</button>
                <button v-if="images.length > 1" type="button" class="figure-nav next" aria-label="Next photo" @click="nextImage(1)">›</button>
                <span v-if="images.length > 1" class="figure-count">{{ imageIndex + 1 }} / {{ images.length }}</span>
              </div>
              <figcaption>{{ activeImage.credit }}</figcaption>
              <div v-if="images.length > 1" class="modal-thumbs">
                <button
                  v-for="(image, index) in images"
                  :key="image.url"
                  type="button"
                  :class="{ active: index === imageIndex }"
                  :aria-label="`Photo ${index + 1}`"
                  @click="imageIndex = index"
                >
                  <img :src="image.thumb || image.url" :alt="image.alt" loading="lazy" referrerpolicy="no-referrer" />
                </button>
              </div>
            </figure>

            <p v-else class="modal-noimage">
              <span aria-hidden="true">🖼️</span>
              No photo available.
              <template v-if="details.limitations?.length"> {{ details.limitations[0] }}</template>
            </p>

            <p v-if="details.about" class="modal-about">{{ details.about }}</p>

            <!-- ------------------------------------------------------ Quick actions -->
            <div class="modal-quick">
              <a :href="details.links.directions" target="_blank" rel="noopener noreferrer" class="quick-btn primary">
                <span aria-hidden="true">🧭</span> Directions
              </a>
              <a v-if="contactEntries.find((e) => e.key === 'phone')" :href="contactEntries.find((e) => e.key === 'phone').href" class="quick-btn">
                <span aria-hidden="true">📞</span> Call
              </a>
              <a v-if="contactEntries.find((e) => e.key === 'website')" :href="contactEntries.find((e) => e.key === 'website').href" target="_blank" rel="noopener noreferrer" class="quick-btn">
                <span aria-hidden="true">🌐</span> Website
              </a>
              <a v-if="details.orderLinks?.length" :href="details.orderLinks[0].url" target="_blank" rel="noopener noreferrer" class="quick-btn">
                <span aria-hidden="true">🛵</span> {{ details.orderLinks[0].label }}
              </a>
              <a :href="details.links.googleMaps" target="_blank" rel="noopener noreferrer" class="quick-btn">
                <span aria-hidden="true">🗺️</span> Google Maps
              </a>
            </div>

            <!-- -------------------------------------------------- Price per person -->
            <section v-if="priceBands.length" class="modal-section">
              <h3>
                Price per person
                <span class="section-note">Google Maps · {{ formatCount(priceVotesTotal) }} people reported what they spent</span>
              </h3>
              <p class="price-lead">
                Most people spend <strong>{{ topPriceBand.label }}</strong>
              </p>
              <ul class="price-bands">
                <li
                  v-for="band in priceBands"
                  :key="band.label"
                  :class="{ top: band.label === topPriceBand.label }"
                  :title="`${formatCount(band.votes)} of ${formatCount(priceVotesTotal)} people`"
                >
                  <span class="price-band-label">{{ band.label }}</span>
                  <span class="price-track"><i :style="{ width: `${band.pct}%` }"></i></span>
                  <span class="price-band-pct">{{ band.pct }}%</span>
                </li>
              </ul>
            </section>

            <!-- ------------------------------------------------------ At a glance -->
            <section class="modal-section">
              <h3>
                At a glance
                <span class="section-note">{{ knownAttributeCount }} of {{ attributeRows.length }} known</span>
              </h3>
              <ul class="glance-grid">
                <li v-for="row in attributeRows" :key="row.key" :class="{ unknown: !row.cell }">
                  <span class="glance-icon" aria-hidden="true">{{ row.icon }}</span>
                  <span class="glance-label">{{ row.label }}</span>
                  <template v-if="row.cell">
                    <span class="glance-value">{{ row.cell.value }}</span>
                    <span class="glance-source" :title="row.cell.note || ''">
                      {{ sourceLabel(row.cell.source) }}<template v-if="row.cell.note"> · {{ row.cell.note }}</template>
                    </span>
                  </template>
                  <span v-else class="glance-value muted">Not enough data</span>
                </li>
              </ul>
            </section>

            <!-- ----------------------------------------------------------- Videos -->
            <section v-if="!details.unnamed" class="modal-section">
              <h3>
                Videos
                <span class="section-note">YouTube · about this place</span>
              </h3>

              <ul v-if="videosLoading" class="video-list" aria-busy="true">
                <li v-for="n in 3" :key="n" class="video-card skeleton">
                  <span class="shimmer video-thumb"></span>
                  <span class="video-body">
                    <span class="shimmer line w85"></span>
                    <span class="shimmer line w50"></span>
                  </span>
                </li>
              </ul>

              <ul v-else-if="videos.length" class="video-list">
                <li v-for="video in videos" :key="video.id" class="video-card">
                  <a :href="video.url" target="_blank" rel="noopener noreferrer">
                    <span class="video-thumb">
                      <img :src="video.thumbnail" :alt="video.title" loading="lazy" referrerpolicy="no-referrer" />
                      <span class="video-play" aria-hidden="true">▶</span>
                      <span v-if="video.kind === 'short'" class="video-badge">Shorts</span>
                      <span v-else-if="video.duration" class="video-badge">{{ video.duration }}</span>
                    </span>
                    <span class="video-body">
                      <strong class="video-title">{{ video.title }}</strong>
                      <span class="video-meta">
                        <template v-if="video.channel">{{ video.channel }}</template>
                        <template v-if="video.views"> · {{ video.views }}</template>
                        <template v-if="video.published"> · {{ video.published }}</template>
                      </span>
                    </span>
                  </a>
                </li>
              </ul>

              <p v-else class="muted video-empty">
                {{ videosError || "No YouTube video names this place yet." }}
              </p>

              <div v-if="videoLinks.length" class="video-links">
                <span class="pane-title">Search on</span>
                <a v-for="link in videoLinks" :key="link.platform" :href="link.url" target="_blank" rel="noopener noreferrer" class="attr-chip" :class="`video-link-${link.platform}`">
                  {{ link.label }} ↗
                </a>
                <span class="glance-source">Instagram and TikTok only answer signed-in browsers, so those open a search there.</span>
              </div>
            </section>

            <!-- ---------------------------------------------------- Popular times -->
            <section v-if="popularDays.length" class="modal-section">
              <h3>
                Popular times
                <span class="section-note">Google Maps · from visits</span>
              </h3>
              <div class="day-tabs" role="tablist" aria-label="Day">
                <button
                  v-for="day in popularDays"
                  :key="day.dayIndex"
                  type="button"
                  role="tab"
                  :aria-selected="day.dayIndex === popularSelected?.dayIndex"
                  :class="{ active: day.dayIndex === popularSelected?.dayIndex, today: day.dayIndex === todayIndex }"
                  @click="popularDay = day.dayIndex"
                >
                  {{ DAY_SHORT[day.dayIndex - 1] }}
                </button>
              </div>
              <div v-if="popularSelected" class="busy-chart" role="img" :aria-label="`Busyness by hour on ${DAY_SHORT[popularSelected.dayIndex - 1]}`">
                <span
                  v-for="hour in popularSelected.hours"
                  :key="hour.hour"
                  class="busy-bar"
                  :class="{ now: popularSelected.dayIndex === todayIndex && hour.hour === currentHour, closed: !hour.busy }"
                  :style="{ '--h': `${Math.round((hour.busy / popularMax) * 100)}%` }"
                  :title="`${hourLabel(hour.hour)}:00 · ${hour.label || (hour.busy ? hour.busy + '%' : 'closed')}`"
                >
                  <i></i>
                  <b v-if="hour.hour % 3 === 0">{{ hourLabel(hour.hour) }}</b>
                </span>
              </div>
              <p v-if="popularSelected?.waitText" class="busy-wait">⏱️ {{ popularSelected.waitText }}</p>
            </section>

            <!-- ------------------------------------------------------- Facilities -->
            <section v-if="details.attributeGroups?.length" class="modal-section">
              <h3>
                Facilities &amp; options
                <span class="section-note">Google Maps listing</span>
              </h3>
              <div v-for="group in details.attributeGroups" :key="group.id || group.label" class="attr-group">
                <span class="attr-group-label">{{ group.label }}</span>
                <span
                  v-for="item in group.items"
                  :key="item.id || item.label"
                  class="attr-chip"
                  :class="{ no: item.value === false }"
                  :title="item.sentence || ''"
                >
                  <span aria-hidden="true">{{ item.value === false ? "✕" : "✓" }}</span>
                  {{ item.answer ? `${item.label}: ${item.answer}` : item.label }}
                </span>
              </div>
            </section>

            <!-- --------------------------------------------------- From reviews -->
            <section v-if="hasReviewSection" class="modal-section">
              <h3>
                What reviewers say
                <span class="section-note">
                  <template v-if="hasInsights">based on {{ insights.basedOn }} review texts</template>
                  <template v-if="details.reviewCount !== null"> · {{ formatCount(details.reviewCount) }} ratings on Google</template>
                </span>
              </h3>

              <p v-if="insights?.summary" class="review-summary">{{ insights.summary }}</p>

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
                  <span v-for="topic in details.reviewTopics" :key="topic.label" class="attr-chip">
                    {{ topic.label }} <b>{{ topic.count }}</b>
                  </span>
                </div>
              </div>

              <blockquote v-for="snippet in (details.reviewSnippets || []).slice(0, 3)" :key="snippet" class="review-quote highlight">
                “{{ snippet }}”<cite> — Google Maps highlight</cite>
              </blockquote>

              <div v-if="hasInsights" class="review-tabs" role="tablist">
                <button type="button" role="tab" :aria-selected="reviewTab === 'pros'" :class="{ active: reviewTab === 'pros' }" @click="reviewTab = 'pros'">
                  Pros <span class="count">{{ insights.praise.length }}</span>
                </button>
                <button type="button" role="tab" :aria-selected="reviewTab === 'cons'" :class="{ active: reviewTab === 'cons' }" @click="reviewTab = 'cons'">
                  Cons <span class="count">{{ insights.complaints.length }}</span>
                </button>
                <button type="button" role="tab" :aria-selected="reviewTab === 'menu'" :class="{ active: reviewTab === 'menu' }" @click="reviewTab = 'menu'">
                  Best menu <span class="count">{{ insights.bestMenu.length }}</span>
                </button>
                <button type="button" role="tab" :aria-selected="reviewTab === 'reviews'" :class="{ active: reviewTab === 'reviews' }" @click="reviewTab = 'reviews'">
                  Reviews <span class="count">{{ details.reviews.length }}</span>
                </button>
              </div>

              <div v-if="hasInsights && reviewTab === 'pros'" class="review-pane">
                <ul v-if="insights.praise.length" class="theme-list good">
                  <li v-for="theme in insights.praise" :key="theme.label">
                    <span>{{ theme.label }}</span>
                    <span class="mentions">{{ theme.mentions }} of {{ insights.basedOn }}</span>
                  </li>
                </ul>
                <p v-else class="muted">No consistent praise found in the review texts we have.</p>
                <blockquote v-for="quote in insights.pros" :key="quote.text" class="review-quote">
                  “{{ quote.text }}”<cite v-if="quote.author"> — {{ quote.author }}</cite>
                </blockquote>
              </div>

              <div v-if="hasInsights && reviewTab === 'cons'" class="review-pane">
                <h4 class="pane-title">⚠️ Common complaints</h4>
                <ul v-if="insights.complaints.length" class="theme-list bad">
                  <li v-for="theme in insights.complaints" :key="theme.label">
                    <span>{{ theme.label }}</span>
                    <span class="mentions">{{ theme.mentions }} of {{ insights.basedOn }}</span>
                  </li>
                </ul>
                <p v-else class="muted">No recurring complaint in the review texts we have.</p>
                <blockquote v-for="quote in insights.cons" :key="quote.text" class="review-quote">
                  “{{ quote.text }}”<cite v-if="quote.author"> — {{ quote.author }}</cite>
                </blockquote>
              </div>

              <div v-if="hasInsights && reviewTab === 'menu'" class="review-pane">
                <ol v-if="insights.bestMenu.length" class="menu-list">
                  <li v-for="item in insights.bestMenu" :key="item.item">{{ item.item }}</li>
                </ol>
                <p v-else class="muted">Reviewers did not name specific dishes.</p>
              </div>

              <div v-if="hasInsights && reviewTab === 'reviews'" class="review-pane">
                <ul class="modal-reviews">
                  <li v-for="review in visibleReviews" :key="`${review.author}-${review.publishTime || review.relativeTime}`">
                    <p class="review-head">
                      <strong>{{ review.author }}</strong>
                      <span><template v-if="review.rating"><span class="stars">{{ stars(review.rating) }}</span> · </template>{{ review.relativeTime }}</span>
                    </p>
                    <p class="review-text">{{ review.text }}</p>
                    <div v-if="review.photos?.length" class="review-photos">
                      <img
                        v-for="photo in review.photos"
                        :key="photo"
                        :src="photo"
                        :alt="`Photo by ${review.author}`"
                        loading="lazy"
                        referrerpolicy="no-referrer"
                      />
                    </div>
                    <p v-if="review.ownerReply" class="owner-reply"><strong>Owner reply</strong> {{ review.ownerReply }}</p>
                  </li>
                </ul>
                <button v-if="details.reviews.length > 2" type="button" class="link-btn" @click="showAllReviews = !showAllReviews">
                  {{ showAllReviews ? "Show fewer" : `Show all ${details.reviews.length}` }}
                </button>
              </div>
            </section>

            <!-- Stated plainly rather than filled in with invented text. -->
            <p v-else class="modal-unknown">
              <template v-if="details.rating !== null">
                Google shows a {{ details.rating.toFixed(1) }} rating<template v-if="details.reviewCount !== null"> from {{ formatCount(details.reviewCount) }} people</template>,
                but its listing gave no review text.
                <template v-if="details.limitations?.length"> {{ details.limitations[0] }}</template>
              </template>
              <template v-else-if="details.unnamed">
                This place has no name in OpenStreetMap, so nothing more can be looked up.
                <a :href="details.links.editOpenStreetMap" target="_blank" rel="noopener noreferrer">
                  Know it? Add its name on OpenStreetMap
                </a>
                — that fixes it here and in every other OSM-based app.
              </template>
              <template v-else>
                No ratings or reviews available for this place.
                <template v-if="details.limitations?.length"> {{ details.limitations.join(" ") }}</template>
              </template>
            </p>

            <!-- ------------------------------------------------------------ Hours -->
            <section v-if="details.openingHours?.length" class="modal-section">
              <h3>
                Opening hours
                <span class="section-note">{{ sourceLabel(details.provenance?.hours) }}</span>
              </h3>
              <button type="button" class="hours-toggle" :aria-expanded="hoursOpen" @click="hoursOpen = !hoursOpen">
                <span v-if="details.openNow === true" class="badge open">Open</span>
                <span v-else-if="details.openNow === false" class="badge closed">Closed</span>
                <span class="hours-today">{{ todayLine || details.openingHours[0] }}</span>
                <span class="chevron" :class="{ up: hoursOpen }" aria-hidden="true">⌄</span>
              </button>
              <ul v-if="hoursOpen || details.openingHours.length < 7" class="modal-hours">
                <li v-for="line in details.openingHours" :key="line" :class="{ today: line === todayLine }">{{ line }}</li>
              </ul>
            </section>

            <!-- ---------------------------------------------------------- Contact -->
            <section v-if="contactEntries.length" class="modal-section">
              <h3>Contact</h3>
              <ul class="modal-contacts">
                <li v-for="entry in contactEntries" :key="entry.key">
                  <span>{{ entry.label }}</span>
                  <a :href="entry.href" target="_blank" rel="noopener noreferrer">{{ entry.value }}</a>
                  <span class="glance-source">{{ sourceLabel(entry.source) }}</span>
                </li>
              </ul>
            </section>

            <!-- ---------------------------------------------------------- Address -->
            <section v-if="details.address" class="modal-section">
              <h3>Address</h3>
              <p class="modal-address">{{ details.address }}</p>
              <p v-if="details.locatedIn?.name" class="modal-address muted">Inside {{ details.locatedIn.name }}</p>
              <p v-if="details.google?.plusCode" class="modal-address muted">Plus code {{ details.google.plusCode }}</p>
              <div class="modal-inline-actions">
                <button type="button" class="link-btn" @click="copy(details.address, 'address')">
                  {{ copied === "address" ? "Copied ✓" : "Copy address" }}
                </button>
                <button
                  type="button"
                  class="link-btn"
                  @click="copy(`${details.coordinates.lat},${details.coordinates.lng}`, 'coords')"
                >
                  {{ copied === "coords" ? "Copied ✓" : `Copy ${details.coordinates.lat.toFixed(5)}, ${details.coordinates.lng.toFixed(5)}` }}
                </button>
              </div>
            </section>

            <section v-if="details.facts?.length" class="modal-section">
              <h3>Details from OpenStreetMap</h3>
              <dl class="modal-facts">
                <template v-for="fact in details.facts" :key="fact.label">
                  <dt>{{ fact.label }}</dt>
                  <dd>{{ fact.value }}</dd>
                </template>
              </dl>
            </section>

            <section class="modal-section">
              <h3>Open in</h3>
              <div class="modal-links">
                <a :href="details.links.googleMaps" target="_blank" rel="noopener noreferrer" class="link-btn">Google Maps</a>
                <a :href="details.links.openStreetMap" target="_blank" rel="noopener noreferrer" class="link-btn">OpenStreetMap</a>
              </div>
            </section>

            <p class="modal-sources">
              Data from {{ details.dataSources.join(", ") }}.
              <template v-if="hasInsights">
                Pros, cons, waiting time, crowd and menu are counted from {{ insights.basedOn }} review texts, not from all
                {{ formatCount(details.reviewCount) }} ratings.
              </template>
            </p>
          </div>
        </article>
      </div>
    </transition>
  </Teleport>
</template>
