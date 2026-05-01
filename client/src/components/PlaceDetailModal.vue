<script setup>
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

function copyLocation() {
  emit("copy", props.details || props.place);
}

function sentimentLabel(sentiment) {
  if (sentiment === "positive") {
    return "Positive 👍";
  }

  if (sentiment === "negative") {
    return "Negative 👎";
  }

  return "Neutral 😐";
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="closeModal">
    <section class="place-modal" role="dialog" aria-modal="true" aria-label="Place details">
      <div class="place-modal-header">
        <div>
          <p class="eyebrow">PLACE DETAILS</p>
          <h2>{{ details?.name || place?.name || "Place" }}</h2>
        </div>
        <button type="button" class="modal-close" @click="closeModal">Close</button>
      </div>

      <div v-if="loading" class="modal-state">Loading place details...</div>
      <div v-else-if="error" class="modal-state error">{{ error }}</div>
      <div v-else-if="details" class="modal-body">
        <section class="modal-section">
          <h3>Basic Info</h3>
          <p>{{ details.address }}</p>
          <p>{{ details.coordinates.lat }}, {{ details.coordinates.lng }}</p>
        </section>

        <section class="modal-actions-row">
          <a class="action-link" :href="details.googleMapsUrl" target="_blank" rel="noreferrer">Open in Google Maps</a>
          <button type="button" class="action-secondary" @click="copyLocation">Copy location</button>
        </section>

        <section class="modal-section">
          <h3>Contact Info</h3>
          <p v-if="details.instagram">Instagram: <a :href="details.instagram" target="_blank" rel="noreferrer">{{ details.instagram }}</a></p>
          <p v-if="details.website">Website: <a :href="details.website" target="_blank" rel="noreferrer">{{ details.website }}</a></p>
          <p v-if="details.phone">Phone: {{ details.phone }}</p>
          <p v-if="!details.instagram && !details.website && !details.phone">No contact info available.</p>
        </section>

        <section class="modal-section">
          <h3>Rating & Reviews</h3>
          <p>Rating: {{ details.rating }} / 5</p>
          <p>Total reviews: {{ details.reviewCount }}</p>
        </section>

        <section class="modal-section">
          <h3>Price Info</h3>
          <p>Estimated price range: {{ details.priceRange }}</p>
          <p>Example menu: {{ details.exampleMenu.join(", ") }}</p>
        </section>

        <section class="modal-section">
          <h3>Sentiment Analysis</h3>
          <p>{{ sentimentLabel(details.sentiment.sentiment) }}</p>
          <p>{{ Math.round(details.sentiment.score * 100) }}% positive</p>
          <p>{{ details.sentiment.summary }}</p>
        </section>
      </div>
    </section>
  </div>
</template>
