<script setup>
import { computed, ref, watch } from "vue";

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

watch(
  () => props.details,
  () => {
    imageIndex.value = 0;
    hoursOpen.value = false;
    reviewTab.value = "pros";
    showAllReviews.value = false;
  }
);

const images = computed(() => props.details?.images || []);
const activeImage = computed(() => images.value[imageIndex.value] || null);

function nextImage(step) {
  const count = images.value.length;

  if (!count) {
    return;
  }

  imageIndex.value = (imageIndex.value + step + count) % count;
}

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

function formatDistance(metres) {
  if (!Number.isFinite(metres)) {
    return "";
  }

  return metres < 1000 ? `${metres} m` : `${(metres / 1000).toFixed(1)} km`;
}

function formatCount(value) {
  return typeof value === "number" ? value.toLocaleString("id-ID") : "";
}

function stars(rating) {
  const full = Math.round(Number(rating) || 0);
  return "★".repeat(full) + "☆".repeat(Math.max(0, 5 - full));
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="emit('close')">
    <article class="modal" role="dialog" aria-modal="true">
      <button type="button" class="modal-close" aria-label="Close" @click="emit('close')">×</button>

      <header class="modal-header">
        <h2>
          <template v-if="details?.unnamed">Unnamed {{ (details.type || "place").replace(/_/g, " ") }}</template>
          <template v-else>{{ details?.name || place?.name || "Place" }}</template>
        </h2>
        <p v-if="details?.unnamed" class="modal-type">Shown by its street: {{ details.name }}</p>
        <p class="modal-meta">
          <span v-if="details?.categoryLabel" :class="`tag tag-${details.categoryId}`">{{ details.categoryLabel }}</span>
          <span v-if="details?.google?.categoryLabel" class="modal-type">{{ details.google.categoryLabel }}</span>
          <span v-else class="modal-type">{{ (details?.type || place?.tagValue || "").replace(/_/g, " ") }}</span>
          <span v-if="place?.distance" class="modal-type">· {{ formatDistance(place.distance) }} away</span>
        </p>

        <!-- Headline strip: rating · reviews · price · open now. Each value
             names its source; anything unknown is simply absent. -->
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
            {{ details.statusText || "Open now" }}
          </span>
          <span v-else-if="details.openNow === false" class="headline-chip closed">
            {{ details.statusText || "Closed now" }}
          </span>
        </div>
      </header>

      <p v-if="loading" class="modal-status">Loading details…</p>
      <p v-else-if="error" class="modal-status error">{{ error }}</p>

      <div v-else-if="details" class="modal-body">
        <!-- ---------------------------------------------------------- Photos -->
        <figure v-if="activeImage" class="modal-figure">
          <div class="figure-stage">
            <img :src="activeImage.url" :alt="activeImage.alt" loading="lazy" />
            <button v-if="images.length > 1" type="button" class="figure-nav prev" aria-label="Previous photo" @click="nextImage(-1)">‹</button>
            <button v-if="images.length > 1" type="button" class="figure-nav next" aria-label="Next photo" @click="nextImage(1)">›</button>
          </div>
          <figcaption>
            {{ activeImage.credit }}
            <span v-if="images.length > 1">· {{ imageIndex + 1 }} / {{ images.length }}</span>
          </figcaption>
          <div v-if="images.length > 1" class="modal-thumbs">
            <button
              v-for="(image, index) in images"
              :key="image.url"
              type="button"
              :class="{ active: index === imageIndex }"
              @click="imageIndex = index"
            >
              <img :src="image.url" :alt="image.alt" loading="lazy" />
            </button>
          </div>
        </figure>

        <p v-else class="modal-noimage">
          No photo available.
          <template v-if="!details.google?.placeId && details.limitations?.length"> {{ details.limitations[0] }}</template>
          <template v-else-if="details.limitations?.length"> {{ details.limitations[0] }}</template>
        </p>

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

        <!-- --------------------------------------------------- From reviews -->
        <section v-if="hasInsights || insights?.summary" class="modal-section">
          <h3>
            What reviewers say
            <span class="section-note">
              <template v-if="hasInsights">based on {{ insights.basedOn }} review texts</template>
              <template v-if="details.reviewCount !== null"> · {{ formatCount(details.reviewCount) }} ratings on Google</template>
            </span>
          </h3>

          <p v-if="insights.summary" class="review-summary">{{ insights.summary }}</p>

          <div v-if="hasInsights" class="review-tabs" role="tablist">
            <button type="button" role="tab" :class="{ active: reviewTab === 'pros' }" @click="reviewTab = 'pros'">
              Pros <span class="count">{{ insights.praise.length }}</span>
            </button>
            <button type="button" role="tab" :class="{ active: reviewTab === 'cons' }" @click="reviewTab = 'cons'">
              Cons <span class="count">{{ insights.complaints.length }}</span>
            </button>
            <button type="button" role="tab" :class="{ active: reviewTab === 'menu' }" @click="reviewTab = 'menu'">
              Best menu <span class="count">{{ insights.bestMenu.length }}</span>
            </button>
            <button type="button" role="tab" :class="{ active: reviewTab === 'reviews' }" @click="reviewTab = 'reviews'">
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
                  <span><template v-if="review.rating">{{ review.rating }}/5 · </template>{{ review.relativeTime }}</span>
                </p>
                <p class="review-text">{{ review.text }}</p>
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
            Google shows a {{ details.rating.toFixed(1) }} rating from {{ formatCount(details.reviewCount) }} people, but
            review text, price and photos need <code>GOOGLE_PLACES_API_KEY</code>.
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
          <p v-if="details.google?.plusCode" class="modal-address muted">Plus code {{ details.google.plusCode }}</p>
          <div class="modal-inline-actions">
            <button type="button" class="link-btn" @click="copy(details.address, 'address')">
              {{ copied === "address" ? "Copied" : "Copy address" }}
            </button>
            <button
              type="button"
              class="link-btn"
              @click="copy(`${details.coordinates.lat},${details.coordinates.lng}`, 'coords')"
            >
              {{ copied === "coords" ? "Copied" : `Copy ${details.coordinates.lat.toFixed(5)}, ${details.coordinates.lng.toFixed(5)}` }}
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
            <a :href="details.links.directions" target="_blank" rel="noopener noreferrer" class="primary-btn small">
              Directions
            </a>
            <a :href="details.links.googleMaps" target="_blank" rel="noopener noreferrer" class="link-btn">
              Google Maps
            </a>
            <a :href="details.links.openStreetMap" target="_blank" rel="noopener noreferrer" class="link-btn">
              OpenStreetMap
            </a>
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
</template>
