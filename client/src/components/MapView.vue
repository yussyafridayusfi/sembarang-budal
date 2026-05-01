<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import L from "leaflet";

const props = defineProps({
  locations: {
    type: Array,
    default: () => []
  }
});

const mapElement = ref(null);
const mapStatus = ref("Trying to use your current location for the default map view.");

let map;
let locationLayer;
let pathLine;
let tracker;
let trackerInterval;
let userMarker;

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

  if (pathLine) {
    pathLine.remove();
    pathLine = null;
  }

  if (tracker) {
    tracker.remove();
    tracker = null;
  }
}

function centerToDefaultMapView() {
  if (!map || props.locations.length) {
    return;
  }

  if (!navigator.geolocation) {
    mapStatus.value = "Showing a default map view because browser geolocation is not available.";
    map.setView([-2.5, 118], 5);
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      if (!map || props.locations.length) {
        return;
      }

      const userPoint = [position.coords.latitude, position.coords.longitude];
      mapStatus.value = "Map centered on your current location.";
      map.setView(userPoint, 13);

      if (userMarker) {
        userMarker.remove();
      }

      userMarker = L.circleMarker(userPoint, {
        radius: 9,
        color: "#0ea5e9",
        fillColor: "#38bdf8",
        fillOpacity: 0.9,
        weight: 3
      })
        .addTo(map)
        .bindPopup("Your current location");
    },
    () => {
      mapStatus.value = "Location permission was unavailable, so the map is showing a default region.";
      map.setView([-2.5, 118], 5);
    },
    {
      enableHighAccuracy: true,
      timeout: 8000
    }
  );
}

function drawSavedLocations() {
  if (!map) {
    return;
  }

  clearRoute();

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

onMounted(() => {
  map = L.map(mapElement.value).setView([-2.5, 118], 5);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  drawSavedLocations();
});

watch(
  () => props.locations,
  () => {
    drawSavedLocations();
  },
  { deep: true }
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
