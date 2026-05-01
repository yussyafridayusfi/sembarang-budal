<script setup>
import { computed, onMounted, onUnmounted } from "vue";

const props = defineProps({
  open: {
    type: Boolean,
    default: false
  },
  place: {
    type: Object,
    default: null
  },
  details: {
    type: Object,
    default: null
  },
  loading: {
    type: Boolean,
    default: false
  },
  error: {
    type: String,
    default: ""
  }
});

const emit = defineEmits(["close", "copy"]);

function closeModal() {
  emit("close");
}

function copyAddress() {
  emit("copy", props.details || props.place);
}

function handleKeydown(e) {
  if (e.key === "Escape" && props.open) {
    closeModal();
  }
}

onMounted(() => {
  document.addEventListener("keydown", handleKeydown);
});

onUnmounted(() => {
  document.removeEventListener("keydown", handleKeydown);
});

const heroImage = computed(() => props.details?.images?.[0] || null);
const galleryImages = computed(() => props.details?.images?.slice(1) || []);
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="closeModal">
    <section class="place-modal" role="dialog" aria-modal="true" aria-label="Place details">
      <div v-if="loading" class="modal-state">Loading place details...</div>
      <div v-else-if="error" class="modal-state error">{{ error }}</div>
      <div v-else-if="details" class="modal-body">
        <section class="modal-hero" :class="{ 'no-image': !heroImage }">
          <img v-if="heroImage" class="hero-image" :src="heroImage.url" :alt="heroImage.alt" loading="lazy" />

          <div class="place-modal-header overlay">
            <div class="modal-title-block">
              <p class="eyebrow light">PLACE DETAILS</p>
              <h2>{{ details.name || place?.name || "Place" }}</h2>
              <p class="modal-address light">{{ details.address || "Address is not available yet." }}</p>
            </div>
            <button type="button" class="modal-close elevated" @click="closeModal">Close</button>
          </div>

          <div class="hero-meta-row">
            <span class="hero-badge">{{ details.tags?.amenity || place?.type || "place" }}</span>
            <span class="hero-badge subtle">{{ details.rating ? `${details.rating} / 5` : "No rating" }}</span>
            <span class="hero-badge subtle">{{ details.price_range || "Price unknown" }}</span>
          </div>
        </section>

        <section v-if="galleryImages.length" class="image-gallery-section">
          <div class="gallery-header">
            <h3>Photos</h3>
            <span>{{ details.images.length }} images</span>
          </div>
          <div class="image-gallery">
            <img v-for="image in galleryImages" :key="image.url" :src="image.url" :alt="image.alt" loading="lazy" />
          </div>
        </section>

        <section class="modal-actions-row">
          <a class="action-link" :href="details.googleMapsUrl" target="_blank" rel="noreferrer">Open in Google Maps</a>
          <button type="button" class="action-secondary" @click="copyAddress">Copy address</button>
        </section>

        <section class="modal-section info-card">
          <h3>Address</h3>
          <p>{{ details.address }}</p>
        </section>

        <section class="modal-section info-card">
          <h3>Contact Info</h3>
          <div class="contact-list">
            <p v-if="details.contacts?.instagram">Instagram: <a :href="details.contacts.instagram" target="_blank" rel="noreferrer">{{ details.contacts.instagram }}</a></p>
            <p v-if="details.contacts?.website">Website: <a :href="details.contacts.website" target="_blank" rel="noreferrer">{{ details.contacts.website }}</a></p>
            <p v-if="details.contacts?.phone">Phone: {{ details.contacts.phone }}</p>
          </div>
          <p v-if="!details.contacts?.instagram && !details.contacts?.website && !details.contacts?.phone">No contact info available.</p>
        </section>

        <section class="modal-section compact-grid stat-grid">
          <div class="stat-card">
            <span class="stat-label">Rating</span>
            <strong>{{ details.rating ? `${details.rating} / 5` : "Not available" }}</strong>
          </div>
          <div class="stat-card">
            <span class="stat-label">Price</span>
            <strong>{{ details.price_range || "Not available" }}</strong>
          </div>
          <div class="stat-card">
            <span class="stat-label">Reviews</span>
            <strong>{{ details.reviewCount || 0 }}</strong>
          </div>
        </section>

        <section class="modal-section review-section">
          <h3>Review Analysis</h3>

          <div class="review-card positive">
            <div class="review-head">
              <strong>Positive: {{ details.review_analysis?.positive_percentage ?? 0 }}%</strong>
              <div class="review-bar"><span :style="{ width: `${details.review_analysis?.positive_percentage ?? 0}%` }"></span></div>
            </div>
            <p>{{ details.review_analysis?.positive_summary }}</p>
          </div>

          <div class="review-card negative">
            <div class="review-head">
              <strong>Negative: {{ details.review_analysis?.negative_percentage ?? 0 }}%</strong>
              <div class="review-bar negative"><span :style="{ width: `${details.review_analysis?.negative_percentage ?? 0}%` }"></span></div>
            </div>
            <p>{{ details.review_analysis?.negative_summary }}</p>
          </div>
        </section>
      </div>
    </section>
  </div>
</template>
