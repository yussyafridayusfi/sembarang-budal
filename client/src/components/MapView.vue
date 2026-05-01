<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import L from "leaflet";

const props = defineProps({
  locations: {
    type: Array,
    default: () => []
  },
  middleSearch: {
    type: Object,
    default: null
  }
});

const mapElement = ref(null);
const mapStatus = ref("Default map view ready.");

let map;
let locationLayer;
let middleLayer;
let pathLine;
let tracker;
let trackerInterval;
let userMarker;
let midpointMarker;
let midpointCircle;

function clearTrackerInterval() {
  if (trackerInterval) {
    clearInterval(trackerInterval);
    trackerInterval = null;
  }
}

function clearRoute() {
  clearTrackerInterval();

  if (locationLayer) {
    locationLayer.clearLayers();
  }

  if (middleLayer) {
    middleLayer.clearLayers();
  }

  if (pathLine) {
    pathLine.remove();
    pathLine = null;
  }

  if (tracker) {
    tracker.remove();
    tracker = null;
  }

  if (midpointMarker) {
    midpointMarker.remove();
    midpointMarker = null;
  }

  if (midpointCircle) {
    midpointCircle.remove();
    midpointCircle = null;
  }
}

function centerToDefaultMapView() {
  if (!map || props.locations.length) {
    return;
  }

  mapStatus.value = "Showing the default map region.";
  map.setView([-2.5, 118], 5);
}

function drawSavedLocations() {
  if (!map) {
    return;
  }

  clearRoute();

  if (props.middleSearch?.midpoint) {
    drawMiddleSearch();
    return;
  }

  if (userMarker && props.locations.length) {
    userMarker.remove();
    userMarker = null;
  }

  if (!props.locations.length) {
    centerToDefaultMapView();
    return;
  }

  const points = props.locations.map((item) => [item.lat, item.lng]);
  locationLayer = L.layerGroup().addTo(map);
  mapStatus.value = `${props.locations.length} saved location${props.locations.length > 1 ? "s" : ""} on the map.`;

  props.locations.forEach((location, index) => {
    L.circleMarker([location.lat, location.lng], {
      radius: 8,
      color: "#1d4ed8",
      fillColor: "#60a5fa",
      fillOpacity: 0.9,
      weight: 2
    })
      .addTo(locationLayer)
      .bindPopup(`${index + 1}. ${location.displayName || location.name}`);
  });

  if (points.length === 1) {
    map.setView(points[0], 13);
    return;
  }

  pathLine = L.polyline(points, {
    color: "#2563eb",
    weight: 4,
    opacity: 0.9
  }).addTo(map);

  map.fitBounds(pathLine.getBounds(), { padding: [30, 30] });

  let index = 0;
  tracker = L.circleMarker(points[index], {
    radius: 10,
    color: "#ef4444",
    fillColor: "#ef4444",
    fillOpacity: 0.7
  }).addTo(map);

  trackerInterval = setInterval(() => {
    index = (index + 1) % points.length;
    tracker.setLatLng(points[index]);
  }, 1200);
}

function drawMiddleSearch() {
  if (!map || !props.middleSearch?.midpoint) {
    return;
  }

  const midpoint = [props.middleSearch.midpoint.lat, props.middleSearch.midpoint.lng];
  const radius = Number(props.middleSearch.radius || 1000);
  const places = props.middleSearch.places || [];

  middleLayer = L.layerGroup().addTo(map);
  mapStatus.value = places.length
    ? `${places.length} place${places.length > 1 ? "s" : ""} found near the midpoint.`
    : "No nearby places found for this radius.";

  midpointMarker = L.circleMarker(midpoint, {
    radius: 11,
    color: "#7c3aed",
    fillColor: "#a855f7",
    fillOpacity: 0.95,
    weight: 3
  })
    .addTo(middleLayer)
    .bindPopup("Midpoint");

  midpointCircle = L.circle(midpoint, {
    radius,
    color: "#7c3aed",
    weight: 2,
    fillColor: "#c084fc",
    fillOpacity: 0.12
  }).addTo(middleLayer);

  places.forEach((place) => {
    L.marker([place.lat, place.lng])
      .addTo(middleLayer)
      .bindPopup(`${place.name} (${place.type})`);
  });

  const bounds = midpointCircle.getBounds();
  if (places.length) {
    places.forEach((place) => bounds.extend([place.lat, place.lng]));
  }

  map.fitBounds(bounds, { padding: [40, 40] });
}

onMounted(() => {
  map = L.map(mapElement.value).setView([-2.5, 118], 5);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  drawSavedLocations();
});

watch(
  () => [props.locations, props.middleSearch],
  () => {
    drawSavedLocations();
  },
  { deep: true, immediate: false }
);

onBeforeUnmount(() => {
  clearRoute();
  if (userMarker) {
    userMarker.remove();
  }
  if (map) {
    map.remove();
  }
});
</script>

<template>
  <div>
    <div ref="mapElement" class="map"></div>
    <p class="map-status">{{ mapStatus }}</p>
  </div>
</template>
