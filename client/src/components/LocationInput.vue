<script setup>
import { reactive, ref } from "vue";
import { searchLocations } from "../services/api";

const props = defineProps({
  locations: {
    type: Array,
    required: true
  },
  disabled: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(["update:locations"]);

const suggestionsByIndex = reactive({});
const searchingByIndex = reactive({});
const searchControllers = new Map();
const searchTimers = new Map();
const activeSuggestionIndex = ref(-1);

function updateLocation(index, value) {
  const nextLocations = [...props.locations];
  nextLocations[index] = value;
  emit("update:locations", nextLocations);
}

function clearSuggestions(index) {
  suggestionsByIndex[index] = [];
  searchingByIndex[index] = false;
  if (activeSuggestionIndex.value === index) {
    activeSuggestionIndex.value = -1;
  }
}

function scheduleSearch(index, value) {
  const query = value.trim();

  if (searchTimers.has(index)) {
    clearTimeout(searchTimers.get(index));
  }

  if (searchControllers.has(index)) {
    searchControllers.get(index).abort();
    searchControllers.delete(index);
  }

  if (query.length < 2) {
    clearSuggestions(index);
    return;
  }

  searchingByIndex[index] = true;
  activeSuggestionIndex.value = index;

  const timer = setTimeout(async () => {
    const controller = new AbortController();
    searchControllers.set(index, controller);

    try {
      const response = await searchLocations(query, controller.signal);
      suggestionsByIndex[index] = response.suggestions || [];
    } catch (error) {
      if (error.name !== "AbortError") {
        suggestionsByIndex[index] = [];
      }
    } finally {
      searchingByIndex[index] = false;
      searchControllers.delete(index);
    }
  }, 300);

  searchTimers.set(index, timer);
}

function handleInput(index, event) {
  const value = event.target.value;
  updateLocation(index, value);
  scheduleSearch(index, value);
}

function selectSuggestion(index, suggestion) {
  updateLocation(index, suggestion.displayName);
  clearSuggestions(index);
}

function addLocationField() {
  emit("update:locations", [...props.locations, ""]);
}

function removeLocation(index) {
  const nextLocations = props.locations.filter((_, itemIndex) => itemIndex !== index);
  emit("update:locations", nextLocations.length ? nextLocations : [""]);
  clearSuggestions(index);
}

function handleFocus(index, value) {
  if ((suggestionsByIndex[index] || []).length) {
    activeSuggestionIndex.value = index;
  }

  if (value.trim().length >= 2) {
    scheduleSearch(index, value);
  }
}

function handleBlur(index) {
  window.setTimeout(() => {
    if (activeSuggestionIndex.value === index) {
      activeSuggestionIndex.value = -1;
    }
  }, 150);
}
</script>

<template>
  <div class="input-wrap">
    <div class="input-header">
      <div>
        <label>Locations</label>
        <p class="field-help">Search Indonesian places only, then pick a suggestion from the list.</p>
      </div>
      <button type="button" :disabled="disabled" @click="addLocationField">Add</button>
    </div>

    <div class="location-stack">
      <div v-for="(location, index) in locations" :key="index" class="location-row">
        <span class="location-number">{{ index + 1 }}</span>

        <div class="location-field-wrap">
          <input
            :value="location"
            type="text"
            :placeholder="`Indonesian address ${index + 1}`"
            :disabled="disabled"
            autocomplete="off"
            @input="handleInput(index, $event)"
            @focus="handleFocus(index, location)"
            @blur="handleBlur(index)"
          />

          <p v-if="searchingByIndex[index]" class="field-status">Searching...</p>

          <ul
            v-if="activeSuggestionIndex === index && (suggestionsByIndex[index] || []).length"
            class="suggestion-list"
          >
            <li v-for="suggestion in suggestionsByIndex[index]" :key="`${suggestion.displayName}-${suggestion.lat}`">
              <button type="button" class="suggestion-btn" @mousedown.prevent="selectSuggestion(index, suggestion)">
                {{ suggestion.displayName }}
              </button>
            </li>
          </ul>
        </div>

        <button type="button" class="remove-btn" :disabled="disabled" @click="removeLocation(index)">
          Remove
        </button>
      </div>
    </div>
  </div>
</template>
