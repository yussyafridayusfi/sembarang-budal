<script setup>
import { computed, ref, watch } from "vue";
import { clearSavedRoute, saveRoute, searchLocations } from "../services/api";

const props = defineProps({
  locations: { type: Array, default: () => [] },
  center: { type: Object, default: null },
  suggestedRadius: { type: Number, default: 2000 },
  /** The map's view centre - the bias when no row is pinned and no midpoint exists. */
  mapCenter: { type: Object, default: null }
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
/** Row keys whose text could not be placed on the map at save time. */
const unresolved = ref(new Set());

const suggestionsByRow = ref({});
/** Per row: how a pasted Google link was read, and whether it found anything. */
const linkByRow = ref({});
/** Per row: the area used when the linked place itself is not on the map. */
const areaByRow = ref({});
const searchingByRow = ref({});
const openRow = ref(-1);

const timers = new Map();
const controllers = new Map();

function createRow(name = "") {
  return { key: `row-${Math.random().toString(36).slice(2, 9)}`, name, lat: null, lng: null, displayName: "" };
}

/**
 * Place a typed row that was never picked from the list. The first suggestion
 * is accepted only when it shares the typed name's identifying tokens - the
 * server relaxes addresses, so "Jl. Nowhere 99" can come back as the whole
 * village, and a pin there is worse than an honest "not found".
 */
async function resolveRow(row) {
  const query = row.name.trim();
  const anchor = rows.value.find((other) => other !== row && other.lat !== null) || props.center || props.mapCenter;
  const response = await searchLocations(query, undefined, anchor);
  const best = (response.suggestions || [])[0];

  if (!best || typeof best.lat !== "number" || typeof best.lng !== "number") {
    return null;
  }

  const isCoordinates = /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(query);

  if (isCoordinates || /^https?:\/\//i.test(query)) {
    return best;
  }

  // Same rule as the server's relevance filter: one or two identifying tokens
  // must all appear, three or more need a majority. "Surabaya" alone must not
  // turn "Royal Plaza Surabaya" into the first school in Surabaya.
  const wanted = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
  const haystack = `${best.name || ""} ${best.displayName || ""}`.toLowerCase();
  const matched = wanted.filter((token) => haystack.includes(token)).length;
  const needed = wanted.length <= 2 ? wanted.length : Math.floor(wanted.length / 2) + 1;

  if (wanted.length && matched < needed) {
    return null;
  }

  return best;
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

  // Typing invalidates a previously picked coordinate, and clears an earlier
  // "not found" mark so the row can be tried again.
  row.lat = null;
  row.lng = null;
  row.displayName = "";

  if (unresolved.value.has(row.key)) {
    const next = new Set(unresolved.value);
    next.delete(row.key);
    unresolved.value = next;
  }

  if (query.length < 2) {
    suggestionsByRow.value = { ...suggestionsByRow.value, [index]: [] };
    linkByRow.value = { ...linkByRow.value, [index]: null };
    areaByRow.value = { ...areaByRow.value, [index]: "" };
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
        // Bias towards a location already pinned on another row, then the map
        // centre. A Google share link often carries only a bare name, and the
        // other end of the same trip is the best hint we have about which one.
        const anchor =
          rows.value.find((other, otherIndex) => otherIndex !== index && other.lat !== null) ||
          props.center ||
          props.mapCenter;

        const response = await searchLocations(query, controller.signal, anchor);
        suggestionsByRow.value = { ...suggestionsByRow.value, [index]: response.suggestions || [] };
        linkByRow.value = { ...linkByRow.value, [index]: response.link || null };
        areaByRow.value = { ...areaByRow.value, [index]: response.approximateArea || "" };
      } catch (err) {
        if (err.name !== "AbortError") {
          suggestionsByRow.value = { ...suggestionsByRow.value, [index]: [] };
          linkByRow.value = { ...linkByRow.value, [index]: null };
          areaByRow.value = { ...areaByRow.value, [index]: "" };
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
  linkByRow.value = { ...linkByRow.value, [index]: null };
  areaByRow.value = { ...areaByRow.value, [index]: "" };
  openRow.value = -1;
}

/** "Royal Plaza, Jl. Ahmad Yani…" → "Jl. Ahmad Yani…": the name is already the heading. */
function secondaryLine(suggestion) {
  const name = String(suggestion.name || "").trim();
  const display = String(suggestion.displayName || "").trim();

  if (name && display.toLowerCase().startsWith(name.toLowerCase())) {
    return display.slice(name.length).replace(/^[s,–—-]+/, "");
  }

  return display;
}

function formatDistance(metres) {
  if (!Number.isFinite(metres)) {
    return "";
  }

  if (metres >= 100000) {
    return `${Math.round(metres / 1000)} km`;
  }

  return metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres)} m`;
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

  // Every location must sit on the map before anything is saved. A row typed
  // but never picked is looked up now; one that cannot be placed blocks the
  // save and is pointed out, rather than being dropped silently server-side.
  const filled = rows.value.filter((row) => row.name.trim());
  const missing = new Set();

  for (const row of filled) {
    if (row.lat !== null) {
      continue;
    }

    try {
      const match = await resolveRow(row);

      if (match) {
        row.lat = match.lat;
        row.lng = match.lng;
        row.displayName = match.displayName || "";
      } else {
        missing.add(row.key);
      }
    } catch {
      missing.add(row.key);
    }
  }

  unresolved.value = missing;

  if (missing.size) {
    const names = filled.filter((row) => missing.has(row.key)).map((row) => `“${row.name.trim()}”`);
    error.value =
      (names.length === 1 ? `${names[0]} was not found on the map.` : `${names.join(", ")} were not found on the map.`) +
      " Pick a suggestion from the list, paste a Google Maps link, or type the coordinates as lat,lng. Nothing was saved.";
    saving.value = false;
    return;
  }

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

    if (failed.value.length) {
      error.value = "Some locations could not be placed and were left out. Fix them and save again.";
    }

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
      <div
        v-for="(row, index) in rows"
        :key="row.key"
        class="row"
        :class="{ 'row-unresolved': unresolved.has(row.key), 'row-is-pinned': row.lat !== null }"
      >
        <span class="row-index">{{ index + 1 }}</span>

        <div class="row-main">
          <div class="combo">
            <input
              type="text"
              :placeholder="`Location ${index + 1} — name, address, Maps link, or lat,lng`"
              autocomplete="off"
              :value="row.name"
              :aria-invalid="unresolved.has(row.key)"
              @input="onInput(index, $event)"
              @focus="openRow = index"
              @blur="openRow = -1"
            />

            <span
              v-if="row.lat !== null"
              class="row-check"
              title="Pinned — the coordinates you picked are locked to this row"
              aria-hidden="true"
              >✓</span
            >

            <ul
              v-if="
                openRow === index &&
                (suggestionsByRow[index]?.length || searchingByRow[index] || linkByRow[index])
              "
              class="combo-list"
            >
              <li v-if="searchingByRow[index]" class="combo-status">Searching…</li>
              <li
                v-else-if="!suggestionsByRow[index]?.length && linkByRow[index]"
                class="combo-status combo-error"
              >
                <span class="combo-note-title">Not on the map: “{{ linkByRow[index].name }}”</span>
                <span class="combo-note-body">
                  That link carries only a name. Share from Google Maps for the exact position, or
                  click the map to place the point.
                </span>
              </li>
              <li v-else-if="areaByRow[index]" class="combo-status combo-relaxed">
                <span class="combo-note-title">
                  “{{ linkByRow[index]?.name }}” is not on the map
                </span>
                <span class="combo-note-body">
                  Showing {{ areaByRow[index] }}, the area named in the link. Drop a pin on the map
                  if you need the exact spot.
                </span>
              </li>
              <li
                v-else-if="linkByRow[index] && linkByRow[index].kind === 'name'"
                class="combo-status combo-relaxed"
              >
                <span class="combo-note-title">Link gave a name, not a position</span>
                <span class="combo-note-body">
                  Looked up “{{ linkByRow[index].name }}” — check the match below is the right one.
                </span>
              </li>
              <li v-for="suggestion in suggestionsByRow[index] || []" :key="`${suggestion.osmType}${suggestion.osmId}${suggestion.lat}`">
                <button type="button" @mousedown.prevent="pickSuggestion(index, suggestion)">
                  <span class="suggest-glyph" aria-hidden="true">📍</span>
                  <strong>
                    {{ suggestion.name || suggestion.displayName }}
                    <em v-if="formatDistance(suggestion.distance)" class="suggest-distance">{{ formatDistance(suggestion.distance) }}</em>
                  </strong>
                  <span v-if="secondaryLine(suggestion)">{{ secondaryLine(suggestion) }}</span>
                </button>
              </li>
            </ul>
          </div>

          <p v-if="row.lat !== null && secondaryLine(row)" class="row-address">
            <span aria-hidden="true">📍</span>
            <span class="row-address-text">{{ secondaryLine(row) }}</span>
          </p>
          <p v-else-if="unresolved.has(row.key)" class="row-address row-address-error" role="alert">
            <span aria-hidden="true">⚠</span>
            <span class="row-address-text">
              Not found on the map — pick a suggestion, paste a Maps link, or type lat,lng.
            </span>
          </p>
        </div>

        <button type="button" class="icon-btn" aria-label="Remove location" @click="removeRow(index)">×</button>
      </div>
    </div>

    <button type="button" class="link-btn" @click="addRow">+ Add another location</button>

    <p v-if="error" class="notice error" role="alert">{{ error }}</p>

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
