<script setup>
import { computed, onMounted, ref } from "vue";
import LocationInput from "./components/LocationInput.vue";
import MapView from "./components/MapView.vue";
import { fetchLocations, saveLocations } from "./services/api";

const draftLocations = ref(["", ""]);
const savedLocations = ref([]);
const loading = ref(false);
const error = ref("");

const filledLocations = computed(() =>
  draftLocations.value.map((item) => item.trim()).filter(Boolean)
);

const canSave = computed(() => filledLocations.value.length >= 2 && !loading.value);

function updateDraftLocations(nextLocations) {
  draftLocations.value = nextLocations;
  error.value = "";
}

async function loadSavedLocations() {
  loading.value = true;
  error.value = "";

  try {
    const response = await fetchLocations();
    savedLocations.value = response.locations || [];
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

async function handleSave() {
  if (!canSave.value) {
    error.value = "Please add at least 2 locations before saving.";
    return;
  }

  loading.value = true;
  error.value = "";

  try {
    const response = await saveLocations(filledLocations.value);
    savedLocations.value = response.locations || [];
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

onMounted(loadSavedLocations);
</script>

<template>
  <main class="app-shell">
    <MapView :locations="savedLocations" />

    <aside class="sidebar">
      <div class="sidebar-top">
        <h1>Maps Route Planner</h1>
        <p class="subtitle">Search multiple places on the left and save to draw the route on the map.</p>
      </div>

      <LocationInput :locations="draftLocations" :disabled="loading" @update:locations="updateDraftLocations" />

      <div class="sidebar-actions">
        <button class="save-btn" :disabled="!canSave" @click="handleSave">
          <span v-if="loading">Saving...</span>
          <span v-else>Save Route</span>
        </button>
        <p class="hint">{{ filledLocations.length }} location(s) entered. Minimum 2 required.</p>
        <p v-if="error" class="error">{{ error }}</p>
        <p v-if="savedLocations.length < 2" class="empty-state">No saved route yet.</p>
      </div>
    </aside>
  </main>
</template>
