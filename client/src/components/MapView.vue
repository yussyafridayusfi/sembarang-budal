<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import L from "leaflet";

const props = defineProps({
  locations: {
    type: Array,
    default: () => []
  },
  meetingSearch: {
    type: Object,
    default: null
  }
});

const mapElement = ref(null);
const mapStatus = ref("Default map view ready.");

let map;
let locationLayer;
let meetingLayer;
let pathLine;

function clearLayers() {
  if (locationLayer) {
    locationLayer.clearLayers();
  }

  if (meetingLayer) {
    meetingLayer.clearLayers();
  }

  if (pathLine) {
    pathLine.remove();
    pathLine = null;
  }
}

function centerToDefaultMapView() {
  if (!map) {
    return;
  }

  mapStatus.value = "Showing the default map region.";
  map.setView([-2.5, 118], 5);
}

function drawSavedRoute(points) {
  if (points.length < 2) {
    return;
  }

  pathLine = L.polyline(points, {
    color: "#2563eb",
    weight: 4,
    opacity: 0.8,
    dashArray: "8 8"
  }).addTo(map);
}

function drawMeetingSearch(bounds) {
  if (!props.meetingSearch?.center) {
    return;
  }

  const center = props.meetingSearch.center;
  const centerPoint = [center.lat, center.lng];
  const places = props.meetingSearch.places || [];
  const radius = Number(props.meetingSearch.radius || 1000);

  L.circleMarker(centerPoint, {
    radius: 11,
    color: "#7c3aed",
    fillColor: "#a855f7",
    fillOpacity: 0.95,
    weight: 3
  })
    .addTo(meetingLayer)
    .bindPopup("Central meeting point");

  const radiusCircle = L.circle(centerPoint, {
    radius,
    color: "#7c3aed",
    weight: 2,
    fillColor: "#c084fc",
    fillOpacity: 0.12
  }).addTo(meetingLayer);

  bounds.extend(radiusCircle.getBounds());

  props.locations.forEach((location) => {
    const line = L.polyline(
      [
        [location.lat, location.lng],
        centerPoint
      ],
      {
        color: "#7c3aed",
        weight: 2,
        opacity: 0.65
      }
    );

    line.addTo(meetingLayer);
  });

  if (props.locations.length >= 3) {
    L.polygon(
      props.locations.map((location) => [location.lat, location.lng]),
      {
        color: "#0f766e",
        weight: 2,
        fillColor: "#5eead4",
        fillOpacity: 0.08
      }
    ).addTo(meetingLayer);
  }

  places.forEach((place) => {
    const markerPoint = [place.lat, place.lng];
    L.marker(markerPoint)
      .addTo(meetingLayer)
      .bindPopup(`${place.name} (${place.type})`);
    bounds.extend(markerPoint);
  });

  mapStatus.value = places.length
    ? `${places.length} place${places.length > 1 ? "s" : ""} found near the meeting point.`
    : "Meeting point calculated. No places found in the selected radius.";
}

function drawMap() {
  if (!map) {
    return;
  }

  clearLayers();

  if (!props.locations.length) {
    centerToDefaultMapView();
    return;
  }

  locationLayer = L.layerGroup().addTo(map);
  meetingLayer = L.layerGroup().addTo(map);

  const points = props.locations.map((location) => [location.lat, location.lng]);
  const bounds = L.latLngBounds(points);

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

  if (props.meetingSearch?.center) {
    drawMeetingSearch(bounds);
  } else {
    drawSavedRoute(points);
    mapStatus.value = `${props.locations.length} saved location${props.locations.length > 1 ? "s" : ""} on the map.`;
  }

  map.fitBounds(bounds, { padding: [40, 40] });
}

onMounted(() => {
  map = L.map(mapElement.value).setView([-2.5, 118], 5);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  drawMap();
});

watch(
  () => [props.locations, props.meetingSearch],
  () => {
    drawMap();
  },
  { deep: true }
);

onBeforeUnmount(() => {
  clearLayers();
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
