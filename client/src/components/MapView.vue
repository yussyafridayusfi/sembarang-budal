<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import L from "leaflet";

const props = defineProps({
  center: { type: Object, default: null },
  radius: { type: Number, default: 2000 },
  places: { type: Array, default: () => [] },
  routeLocations: { type: Array, default: () => [] },
  selectedPlaceId: { type: String, default: "" },
  hoveredPlaceId: { type: String, default: "" }
});

const emit = defineEmits(["select-place", "pick-center", "area-changed"]);

const mapElement = ref(null);
const moved = ref(false);

let map = null;
let circleLayer = null;
let centerMarker = null;
let placeLayer = null;
let routeLayer = null;
const markersByPlaceId = new Map();

/** Category colours, kept in step with the chip colours in styles.css. */
const CATEGORY_COLORS = {
  food: "#e8590c",
  cafe: "#b8860b",
  nightlife: "#9333ea",
  shopping: "#0891b2",
  attraction: "#d6336c",
  outdoor: "#2f9e44",
  entertainment: "#7048e8",
  stay: "#1971c2",
  worship: "#5f3dc4",
  essential: "#e03131",
  transport: "#495057",
  education: "#1098ad",
  other: "#868e96"
};

function colorFor(categoryId) {
  return CATEGORY_COLORS[categoryId] || CATEGORY_COLORS.other;
}

function fitToRadius() {
  if (!map || !props.center) {
    return;
  }

  const bounds = L.latLng(props.center.lat, props.center.lng).toBounds(props.radius * 2.2);
  map.fitBounds(bounds, { padding: [24, 24], animate: false });
}

function drawCenter() {
  if (!map || !props.center) {
    return;
  }

  const point = [props.center.lat, props.center.lng];

  if (circleLayer) {
    circleLayer.setLatLng(point).setRadius(props.radius);
  } else {
    circleLayer = L.circle(point, {
      radius: props.radius,
      color: "#1971c2",
      weight: 2,
      fillColor: "#4dabf7",
      fillOpacity: 0.1,
      interactive: false
    }).addTo(map);
  }

  if (centerMarker) {
    centerMarker.setLatLng(point);
  } else {
    centerMarker = L.circleMarker(point, {
      radius: 8,
      color: "#ffffff",
      weight: 3,
      fillColor: "#1971c2",
      fillOpacity: 1
    })
      .addTo(map)
      .bindTooltip("Search centre", { direction: "top" });
  }
}

function drawRoute() {
  if (!map) {
    return;
  }

  if (routeLayer) {
    routeLayer.clearLayers();
  } else {
    routeLayer = L.layerGroup().addTo(map);
  }

  const points = props.routeLocations
    .filter((location) => Number.isFinite(location.lat) && Number.isFinite(location.lng))
    .map((location) => [location.lat, location.lng]);

  if (!points.length) {
    return;
  }

  props.routeLocations.forEach((location, index) => {
    if (!Number.isFinite(location.lat)) {
      return;
    }

    L.marker([location.lat, location.lng], {
      icon: L.divIcon({
        className: "route-pin",
        html: `<span>${index + 1}</span>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13]
      })
    })
      .addTo(routeLayer)
      .bindTooltip(location.displayName || location.name, { direction: "top" });
  });

  if (points.length >= 2) {
    L.polyline(points, {
      color: "#1971c2",
      weight: 2,
      opacity: 0.6,
      dashArray: "6 6"
    }).addTo(routeLayer);
  }
}

function drawPlaces() {
  if (!map) {
    return;
  }

  if (placeLayer) {
    placeLayer.clearLayers();
  } else {
    placeLayer = L.layerGroup().addTo(map);
  }

  markersByPlaceId.clear();

  props.places.forEach((place) => {
    const isSelected = place.id === props.selectedPlaceId;
    const isHovered = place.id === props.hoveredPlaceId;
    const color = colorFor(place.categoryId);

    const marker = L.circleMarker([place.lat, place.lng], {
      radius: isSelected ? 11 : isHovered ? 9 : 6,
      color: isSelected || isHovered ? "#212529" : "#ffffff",
      weight: isSelected || isHovered ? 3 : 1.5,
      fillColor: color,
      fillOpacity: 0.95
    })
      .addTo(placeLayer)
      .bindTooltip(place.name, { direction: "top" });

    marker.on("click", () => emit("select-place", place));
    markersByPlaceId.set(place.id, marker);
  });
}

function redraw() {
  drawCenter();
  drawRoute();
  drawPlaces();
}

onMounted(() => {
  map = L.map(mapElement.value, {
    zoomControl: true,
    // Indonesia by default; replaced as soon as a centre is chosen.
    center: [-2.5, 118],
    zoom: 5
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  // Clicking the map moves the search centre, the way a maps app behaves.
  map.on("click", (event) => {
    emit("pick-center", { lat: event.latlng.lat, lng: event.latlng.lng });
  });

  // Panning does not trigger a search on its own; the user confirms it, so a
  // stray drag never spends a request.
  map.on("moveend", () => {
    if (!props.center) {
      return;
    }

    const mapCenter = map.getCenter();
    const drift = mapCenter.distanceTo(L.latLng(props.center.lat, props.center.lng));
    moved.value = drift > props.radius * 0.25;
  });

  redraw();

  if (props.center) {
    fitToRadius();
  }
});

watch(
  () => [props.center, props.radius],
  () => {
    drawCenter();
    fitToRadius();
    moved.value = false;
  },
  { deep: true }
);

watch(() => props.places, drawPlaces, { deep: true });
watch(() => [props.selectedPlaceId, props.hoveredPlaceId], drawPlaces);
watch(() => props.routeLocations, drawRoute, { deep: true });

watch(
  () => props.selectedPlaceId,
  (id) => {
    const marker = markersByPlaceId.get(id);

    if (marker && map) {
      map.panTo(marker.getLatLng(), { animate: true });
      marker.openTooltip();
    }
  }
);

function searchThisArea() {
  if (!map) {
    return;
  }

  const mapCenter = map.getCenter();
  moved.value = false;
  emit("area-changed", { lat: mapCenter.lat, lng: mapCenter.lng });
}

onBeforeUnmount(() => {
  if (map) {
    map.remove();
    map = null;
  }
});
</script>

<template>
  <div class="map-wrap">
    <div ref="mapElement" class="map" aria-label="Map of places"></div>

    <button v-if="moved" type="button" class="search-area-btn" @click="searchThisArea">
      Search this area
    </button>

    <p class="map-hint">Click anywhere on the map to move the search centre.</p>
  </div>
</template>
