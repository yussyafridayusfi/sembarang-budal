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

watch(
  () => props.details,
  () => {
    imageIndex.value = 0;
  }
);

const images = computed(() => props.details?.images || []);
const activeImage = computed(() => images.value[imageIndex.value] || null);

const contactEntries = computed(() => {
  const contacts = props.details?.contacts || {};

  return [
    { key: "phone", label: "Phone", value: contacts.phone, href: contacts.phone ? `tel:${contacts.phone.replace(/\s/g, "")}` : "" },
    { key: "website", label: "Website", value: contacts.website, href: contacts.website },
    { key: "instagram", label: "Instagram", value: contacts.instagram, href: contacts.instagram },
    { key: "facebook", label: "Facebook", value: contacts.facebook, href: contacts.facebook },
    { key: "email", label: "Email", value: contacts.email, href: contacts.email ? `mailto:${contacts.email}` : "" }
  ].filter((entry) => entry.value);
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
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="emit('close')">
    <article class="modal" role="dialog" aria-modal="true">
      <button type="button" class="modal-close" aria-label="Close" @click="emit('close')">×</button>

      <header class="modal-header">
        <h2>{{ details?.name || place?.name || "Place" }}</h2>
        <p class="modal-meta">
          <span v-if="details?.categoryLabel" :class="`tag tag-${details.categoryId}`">{{ details.categoryLabel }}</span>
          <span class="modal-type">{{ (details?.type || place?.tagValue || "").replace(/_/g, " ") }}</span>
          <span v-if="place?.distance" class="modal-type">· {{ formatDistance(place.distance) }} away</span>
        </p>
      </header>

      <p v-if="loading" class="modal-status">Loading details…</p>
      <p v-else-if="error" class="modal-status error">{{ error }}</p>

      <div v-else-if="details" class="modal-body">
        <figure v-if="activeImage" class="modal-figure">
          <img :src="activeImage.url" :alt="activeImage.alt" loading="lazy" />
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
          No photo is available for this place in OpenStreetMap.
        </p>

        <section v-if="details.address" class="modal-section">
          <h3>Address</h3>
          <p class="modal-address">{{ details.address }}</p>
          <button type="button" class="link-btn" @click="copy(details.address, 'address')">
            {{ copied === "address" ? "Copied" : "Copy address" }}
          </button>
        </section>

        <section class="modal-section">
          <h3>Coordinates</h3>
          <p class="modal-address">
            {{ details.coordinates.lat.toFixed(6) }}, {{ details.coordinates.lng.toFixed(6) }}
          </p>
          <button
            type="button"
            class="link-btn"
            @click="copy(`${details.coordinates.lat},${details.coordinates.lng}`, 'coords')"
          >
            {{ copied === "coords" ? "Copied" : "Copy coordinates" }}
          </button>
        </section>

        <section v-if="details.openingHours?.length" class="modal-section">
          <h3>
            Opening hours
            <span v-if="details.openNow === true" class="badge open">Open now</span>
            <span v-else-if="details.openNow === false" class="badge closed">Closed now</span>
          </h3>
          <ul class="modal-hours">
            <li v-for="line in details.openingHours" :key="line">{{ line }}</li>
          </ul>
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

        <section v-if="contactEntries.length" class="modal-section">
          <h3>Contact</h3>
          <ul class="modal-contacts">
            <li v-for="entry in contactEntries" :key="entry.key">
              <span>{{ entry.label }}</span>
              <a :href="entry.href" target="_blank" rel="noopener noreferrer">{{ entry.value }}</a>
            </li>
          </ul>
        </section>

        <section v-if="details.rating !== null" class="modal-section">
          <h3>Rating</h3>
          <p class="modal-rating">
            <strong>{{ details.rating.toFixed(1) }}</strong> / 5
            <span v-if="details.reviewCount"> · {{ details.reviewCount }} reviews</span>
            <span v-if="details.priceLevel"> · {{ details.priceLevel }}</span>
          </p>
          <ul v-if="details.reviews?.length" class="modal-reviews">
            <li v-for="review in details.reviews" :key="`${review.author}-${review.relativeTime}`">
              <p class="review-head">
                <strong>{{ review.author }}</strong>
                <span>{{ review.rating }}/5 · {{ review.relativeTime }}</span>
              </p>
              <p class="review-text">{{ review.text }}</p>
            </li>
          </ul>
        </section>

        <!-- Stated plainly rather than filled in with invented numbers. -->
        <p v-else class="modal-unknown">
          No ratings or reviews available. Ratings need a Google Places API key
          (<code>GOOGLE_PLACES_API_KEY</code>); OpenStreetMap does not carry them.
        </p>

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

        <p class="modal-sources">Data from {{ details.dataSources.join(", ") }}.</p>
      </div>
    </article>
  </div>
</template>
