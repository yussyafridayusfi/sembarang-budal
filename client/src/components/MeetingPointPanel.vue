<script setup>
import { computed, ref, watch } from "vue";
import { clearSavedRoute, saveRoute, searchLocations } from "../services/api";

const props = defineProps({
  locations: { type: Array, default: () => [] },
  center: { type: Object, default: null },
  suggestedRadius: { type: Number, default: 2000 }
});

const emit = defineEmits(["saved", "use-center"]);

/**
 * Each row keeps the coordinates of the suggestion the user picked. Sending
 * them with the save means the server does not re-geocode the text and risk
 * resolving to a different place than the one that was clicked.
 */
const rows = ref([createRow(), createRow()]);
const saving = ref(false);
const error = ref("");
const failed = ref([]);

const suggestionsByRow = ref({});
const searchingByRow = ref({});
const openRow = ref(-1);

const timers = new Map();
const controllers = new Map();

function createRow(name = "") {
  return { key: `row-${Math.random().toString(36).slice(2, 9)}`, name, lat: null, lng: null, displayName: "" };
}

// Reflect an already-saved route back into the editable rows on first load.
watch(
  () => props.locations,
  (locations) => {
    if (!locations.length || rows.value.some((row) => row.lat !== null)) {
      return;
    }

    rows.value = locations.map((location) => ({
      key: `row-${Math.random().toString(36).slice(2, 9)}`,
      name: location.name || location.displayName || "",
      displayName: location.displayName || "",
      lat: location.lat,
      lng: location.lng
    }));
  },
  { immediate: true }
);

const readyCount = computed(() => rows.value.filter((row) => row.name.trim()).length);
const canSave = computed(() => readyCount.value >= 2 && !saving.value);

function scheduleSuggest(index, value) {
  const row = rows.value[index];
  clearTimeout(timers.get(index));
  controllers.get(index)?.abort();

  const query = value.trim();

  // Typing invalidates a previously picked coordinate.
  row.lat = null;
  row.lng = null;

  if (query.length < 2) {
    suggestionsByRow.value = { ...suggestionsByRow.value, [index]: [] };
    searchingByRow.value = { ...searchingByRow.value, [index]: false };
    return;
  }

  searchingByRow.value = { ...searchingByRow.value, [index]: true };
  openRow.value = index;

  timers.set(
    index,
    setTimeout(async () => {
      const controller = new AbortController();
      controllers.set(index, controller);

      try {
        const response = await searchLocations(query, controller.signal);
        suggestionsByRow.value = { ...suggestionsByRow.value, [index]: response.suggestions || [] };
      } catch (err) {
        if (err.name !== "AbortError") {
          suggestionsByRow.value = { ...suggestionsByRow.value, [index]: [] };
        }
      } finally {
        searchingByRow.value = { ...searchingByRow.value, [index]: false };
      }
    }, 350)
  );
}

function onInput(index, event) {
  rows.value[index].name = event.target.value;
  scheduleSuggest(index, event.target.value);
}

function pickSuggestion(index, suggestion) {
  rows.value[index] = {
    ...rows.value[index],
    name: suggestion.name || suggestion.displayName,
    displayName: suggestion.displayName,
    lat: suggestion.lat,
    lng: suggestion.lng
  };

  suggestionsByRow.value = { ...suggestionsByRow.value, [index]: [] };
  openRow.value = -1;
}

function addRow() {
  rows.value = [...rows.value, createRow()];
}

function removeRow(index) {
  const next = rows.value.filter((_, rowIndex) => rowIndex !== index);
  rows.value = next.length >= 2 ? next : [...next, createRow()];
}

async function save() {
  if (!canSave.value) {
    error.value = "Add at least 2 locations first.";
    return;
  }

  saving.value = true;
  error.value = "";
  failed.value = [];

  try {
    const payload = await saveRoute(
      rows.value
        .filter((row) => row.name.trim())
        .map((row) => ({
          name: row.name.trim(),
          displayName: row.displayName,
          lat: row.lat,
          lng: row.lng
        }))
    );

    failed.value = payload.failed || [];
    emit("saved", payload);
  } catch (err) {
    error.value = err.message;
  } finally {
    saving.value = false;
  }
}

async function reset() {
  try {
    const payload = await clearSavedRoute();
    rows.value = [createRow(), createRow()];
    failed.value = [];
    emit("saved", payload);
  } catch (err) {
    error.value = err.message;
  }
}

function formatRadius(metres) {
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${metres} m`;
}
</script>

<template>
  <section class="panel">
    <header class="panel-header">
      <h2>Meeting point</h2>
      <p class="panel-sub">
        Add where everyone is coming from. The midpoint becomes the search centre, with a radius
        wide enough to reach everyone.
      </p>
    </header>

    <div class="rows">
      <div v-for="(row, index) in rows" :key="row.key" class="row">
        <span class="row-index">{{ index + 1 }}</span>

        <div class="combo">
          <input
            type="text"
            :placeholder="`Location ${index + 1}`"
            autocomplete="off"
            :value="row.name"
            @input="onInput(index, $event)"
            @focus="openRow = index"
            @blur="openRow = -1"
          />

          <span v-if="row.lat !== null" class="row-pinned" title="Coordinates locked from your pick">pinned</span>

          <ul v-if="openRow === index && (suggestionsByRow[index]?.length || searchingByRow[index])" class="combo-list">
            <li v-if="searchingByRow[index]" class="combo-status">Searching…</li>
            <li v-for="suggestion in suggestionsByRow[index] || []" :key="`${suggestion.osmType}${suggestion.osmId}${suggestion.lat}`">
              <button type="button" @mousedown.prevent="pickSuggestion(index, suggestion)">
                <strong>{{ suggestion.name }}</strong>
                <span>{{ suggestion.displayName }}</span>
              </button>
            </li>
          </ul>
        </div>

        <button type="button" class="icon-btn" aria-label="Remove location" @click="removeRow(index)">×</button>
      </div>
    </div>

    <button type="button" class="link-btn" @click="addRow">+ Add another location</button>

    <p v-if="error" class="notice error">{{ error }}</p>

    <ul v-if="failed.length" class="notice warn">
      <li v-for="item in failed" :key="item.input">“{{ item.input }}” — {{ item.reason }}</li>
    </ul>

    <div class="panel-actions">
      <button type="button" class="primary-btn" :disabled="!canSave" @click="save">
        {{ saving ? "Saving…" : "Save locations" }}
      </button>
      <button v-if="locations.length" type="button" class="link-btn" @click="reset">Clear</button>
    </div>

    <div v-if="center" class="midpoint">
      <p>
        Midpoint: <strong>{{ center.lat.toFixed(5) }}, {{ center.lng.toFixed(5) }}</strong>
      </p>
      <p class="panel-sub">Suggested radius {{ formatRadius(suggestedRadius) }} — reaches every location.</p>
      <button type="button" class="primary-btn" @click="emit('use-center')">
        Explore around the midpoint
      </button>
    </div>
  </section>
</template>
