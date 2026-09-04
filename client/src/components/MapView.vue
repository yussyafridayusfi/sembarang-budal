<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import L from "leaflet";
import "leaflet.markercluster";
import {
  colorFor,
  displayName,
  formatDistance,
  formatRadius,
  iconFor,
  typeLabel,
  walkingMinutes
} from "../lib/categories";

const props = defineProps({
  center: { type: Object, default: null },
  radius: { type: Number, default: 2000 },
  places: { type: Array, default: () => [] },
  routeLocations: { type: Array, default: () => [] },
  selectedPlaceId: { type: String, default: "" },
  hoveredPlaceId: { type: String, default: "" },
  /** Pixels of map hidden behind the floating sidebar, so fits stay visible. */
  insetLeft: { type: Number, default: 0 },
  locating: { type: Boolean, default: false }
});

const emit = defineEmits([
  "select-place",
  "preview-place",
  "hover-place",
  "pick-center",
  "area-changed",
  "update:radius",
  "use-my-location"
]);

const mapElement = ref(null);
const moved = ref(false);
const draggingRadius = ref(false);
const liveRadius = ref(props.radius);

let map = null;
let circleLayer = null;
let centerMarker = null;
let radiusHandle = null;
let clusterLayer = null;
let routeLayer = null;
const markersByPlaceId = new Map();

const MIN_RADIUS = 200;
const MAX_RADIUS = 30000;

/* ------------------------------------------------------------------ icons */

function pinIcon(place, { selected = false, hovered = false } = {}) {
  const state = selected ? "is-selected" : hovered ? "is-hovered" : "";
  const size = selected ? 40 : hovered ? 34 : 30;

  return L.divIcon({
    className: `place-pin ${state}`,
    html: `<span class="pin-body" style="--pin:${colorFor(place.categoryId)}"><span class="pin-glyph">${iconFor(
      place.categoryId
    )}</span></span><span class="pin-tip" style="--pin:${colorFor(place.categoryId)}"></span>`,
    iconSize: [size, size + 8],
    iconAnchor: [size / 2, size + 8],
    popupAnchor: [0, -(size + 4)]
  });
}

function clusterIcon(cluster) {
  const children = cluster.getAllChildMarkers();
  const counts = new Map();

  children.forEach((marker) => {
    const id = marker.options.categoryId || "other";
    counts.set(id, (counts.get(id) || 0) + 1);
  });

  // Colour the badge by its dominant category so a cluster still says what it
  // is mostly made of, and show the second colour as a ring.
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const primary = colorFor(ranked[0]?.[0]);
  const secondary = colorFor(ranked[1]?.[0] || ranked[0]?.[0]);
  const count = children.length;
  const size = count >= 100 ? 50 : count >= 25 ? 44 : 38;

  return L.divIcon({
    className: "place-cluster",
    html: `<span class="cluster-body" style="--c1:${primary};--c2:${secondary};width:${size}px;height:${size}px">${count}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  });
}

const centreIcon = L.divIcon({
  className: "centre-pin",
  html: '<span class="centre-dot"></span><span class="centre-pulse"></span>',
  iconSize: [22, 22],
  iconAnchor: [11, 11]
});

const handleIcon = L.divIcon({
  className: "radius-handle",
  html: '<span class="handle-dot" title="Drag to change the radius"></span>',
  iconSize: [22, 22],
  iconAnchor: [11, 11]
});

/* -------------------------------------------------------------- geometry */

/** The point due east of the centre at `radius` metres - where the handle sits. */
function handlePosition(center, radius) {
  const latLng = L.latLng(center.lat, center.lng);
  const metresPerDegreeLng = 111320 * Math.cos((center.lat * Math.PI) / 180);
  return L.latLng(latLng.lat, latLng.lng + radius / metresPerDegreeLng);
}

function snapRadius(metres) {
  const step = metres < 1000 ? 50 : metres < 5000 ? 100 : 500;
  return Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, Math.round(metres / step) * step));
}

/** Padding for the sidebar, clamped to the map's actual size. Before the
 * container has been laid out Leaflet believes it is tiny, and padding wider
 * than the map makes the fit resolve to a NaN centre. */
function fitPadding() {
  const size = map.getSize();
  const left = Math.min(props.insetLeft + 24, Math.max(0, size.x - 120));

  return {
    paddingTopLeft: [left, 24],
    paddingBottomRight: [24, 24]
  };
}

function fitToRadius(animate = true) {
  if (!map || !props.center) {
    return;
  }

  const size = map.getSize();

  if (size.x < 60 || size.y < 60) {
    // Not laid out yet - the ResizeObserver below re-fits once it is.
    pendingFit = true;
    return;
  }

  try {
    const bounds = L.latLng(props.center.lat, props.center.lng).toBounds(props.radius * 2.1);
    map.flyToBounds(bounds, { ...fitPadding(), animate, duration: animate ? 0.6 : 0 });
  } catch (error) {
    // A Leaflet geometry error must not propagate into Vue's scheduler, where
    // it aborts the component update and leaves the page half-rendered.
    console.warn("[map] fit skipped:", error.message);
  }
}

let pendingFit = false;
let resizeObserver = null;
/** True between movestart and moveend. Redrawing markers or starting a second
 * zoom while a fly-to is in flight leaves markercluster with badges from the
 * old zoom level and marker panes out of step with the overlay pane. */
let animating = false;
let animatingSince = 0;
let pendingPlaces = false;
let pendingShowId = "";

/** A fly-to whose frames never ran (background tab, interrupted animation)
 * would otherwise leave `animating` stuck and every redraw deferred forever. */
function isAnimating() {
  return animating && performance.now() - animatingSince < 1500;
}

/* ---------------------------------------------------------------- layers */

function drawCenter() {
  if (!map || !props.center) {
    return;
  }

  const point = [props.center.lat, props.center.lng];
  const radius = draggingRadius.value ? liveRadius.value : props.radius;

  if (circleLayer) {
    circleLayer.setLatLng(point).setRadius(radius);
  } else {
    circleLayer = L.circle(point, {
      radius,
      color: "#1971c2",
      weight: 2,
      fillColor: "#4dabf7",
      fillOpacity: 0.09,
      interactive: false,
      className: "radius-circle"
    }).addTo(map);
  }

  if (centerMarker) {
    centerMarker.setLatLng(point);
  } else {
    centerMarker = L.marker(point, { icon: centreIcon, draggable: true, zIndexOffset: 900 })
      .addTo(map)
      .bindTooltip("Search centre · drag to move", { direction: "top", offset: [0, -12] });

    centerMarker.on("drag", (event) => {
      const at = event.target.getLatLng();
      circleLayer?.setLatLng(at);
      radiusHandle?.setLatLng(handlePosition(at, props.radius));
    });

    centerMarker.on("dragend", (event) => {
      const at = event.target.getLatLng();
      emit("pick-center", { lat: at.lat, lng: at.lng });
    });
  }

  const handleAt = handlePosition(props.center, radius);

  if (radiusHandle) {
    radiusHandle.setLatLng(handleAt);
  } else {
    radiusHandle = L.marker(handleAt, { icon: handleIcon, draggable: true, zIndexOffset: 950 })
      .addTo(map)
      .bindTooltip(() => formatRadius(liveRadius.value), { direction: "right", offset: [12, 0], permanent: false });

    radiusHandle.on("dragstart", () => {
      draggingRadius.value = true;
      radiusHandle.openTooltip();
    });

    radiusHandle.on("drag", (event) => {
      const at = event.target.getLatLng();
      const centre = centerMarker.getLatLng();
      liveRadius.value = snapRadius(centre.distanceTo(at));
      circleLayer?.setRadius(liveRadius.value);
      // Keep the handle on the circle's east edge rather than wherever the
      // pointer wandered, so it reads as a radius control, not a free marker.
      event.target.setLatLng(handlePosition(centre, liveRadius.value));
      radiusHandle.setTooltipContent(formatRadius(liveRadius.value));
    });

    radiusHandle.on("dragend", () => {
      draggingRadius.value = false;
      radiusHandle.closeTooltip();

      if (liveRadius.value !== props.radius) {
        emit("update:radius", liveRadius.value);
      }
    });
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
    L.polyline(points, { color: "#1971c2", weight: 2, opacity: 0.6, dashArray: "6 6" }).addTo(routeLayer);
  }
}

function popupHtml(place) {
  const distance = Number.isFinite(place.distance)
    ? `<span class="pop-distance">${formatDistance(place.distance)} · ${walkingMinutes(place.distance)} min walk</span>`
    : "";
  const address = place.address ? `<span class="pop-address">${escapeHtml(place.address)}</span>` : "";

  return `
    <div class="place-pop" style="--pin:${colorFor(place.categoryId)}">
      <span class="pop-glyph">${iconFor(place.categoryId)}</span>
      <div class="pop-body">
        <strong class="pop-name">${escapeHtml(displayName(place))}</strong>
        <span class="pop-type">${escapeHtml(typeLabel(place))}</span>
        ${address}
        ${distance}
        <button type="button" class="pop-details" data-place-id="${escapeHtml(place.id)}">See details</button>
      </div>
    </div>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function drawPlaces() {
  if (!map) {
    return;
  }

  if (isAnimating()) {
    pendingPlaces = true;
    return;
  }

  pendingPlaces = false;

  if (clusterLayer) {
    clusterLayer.clearLayers();
  } else {
    clusterLayer = L.markerClusterGroup({
      maxClusterRadius: 44,
      disableClusteringAtZoom: 17,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      zoomToBoundsOnClick: true,
      removeOutsideVisibleBounds: true,
      iconCreateFunction: clusterIcon
    }).addTo(map);
  }

  markersByPlaceId.clear();

  const markers = props.places.map((place) => {
    const marker = L.marker([place.lat, place.lng], {
      icon: pinIcon(place, {
        selected: place.id === props.selectedPlaceId,
        hovered: place.id === props.hoveredPlaceId
      }),
      categoryId: place.categoryId,
      riseOnHover: true
    });

    marker.bindPopup(popupHtml(place), {
      className: "place-popup",
      closeButton: false,
      maxWidth: 280,
      autoPanPaddingTopLeft: [props.insetLeft + 16, 16]
    });

    marker.on("click", () => emit("preview-place", place));
    marker.on("mouseover", () => emit("hover-place", place.id));
    marker.on("mouseout", () => emit("hover-place", ""));
    markersByPlaceId.set(place.id, marker);
    return marker;
  });

  clusterLayer.addLayers(markers);
}

/** Swap the icon of just the markers whose state changed - redrawing every pin
 * on hover was visibly slow with a few hundred of them. */
function refreshPinState(ids) {
  ids.filter(Boolean).forEach((id) => {
    const marker = markersByPlaceId.get(id);
    const place = props.places.find((item) => item.id === id);

    if (marker && place) {
      marker.setIcon(
        pinIcon(place, { selected: id === props.selectedPlaceId, hovered: id === props.hoveredPlaceId })
      );
      marker.setZIndexOffset(id === props.selectedPlaceId ? 800 : id === props.hoveredPlaceId ? 700 : 0);
    }
  });
}

/* --------------------------------------------------------------- actions */

function searchThisArea() {
  if (!map) {
    return;
  }

  const mapCenter = map.getCenter();
  moved.value = false;
  emit("area-changed", { lat: mapCenter.lat, lng: mapCenter.lng });
}

function recentre() {
  fitToRadius(true);
  moved.value = false;
}

function zoomIn() {
  map?.zoomIn();
}

function zoomOut() {
  map?.zoomOut();
}

/* ------------------------------------------------------------- lifecycle */

onMounted(() => {
  map = L.map(mapElement.value, {
    zoomControl: false,
    // Indonesia by default; replaced as soon as a centre is chosen.
    center: [-2.5, 118],
    zoom: 5,
    zoomSnap: 0.5,
    wheelPxPerZoomLevel: 90
  });

  if (import.meta.env.DEV) {
    // Handy in the console while debugging map behaviour; not shipped.
    window.__map = map;
  }

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  // The popup card's "See details" button. Leaflet stops click propagation at
  // the popup container, so listen in the capture phase, which runs first.
  mapElement.value.addEventListener(
    "click",
    (event) => {
      const button = event.target.closest?.(".pop-details");

      if (!button) {
        return;
      }

      const place = props.places.find((item) => item.id === button.dataset.placeId);

      if (place) {
        emit("select-place", place);
      }
    },
    true
  );

  // Clicking the map moves the search centre, the way a maps app behaves.
  map.on("click", (event) => {
    emit("pick-center", { lat: event.latlng.lat, lng: event.latlng.lng });
  });

  map.on("movestart", () => {
    animating = true;
    animatingSince = performance.now();
  });

  // Panning does not trigger a search on its own; the user confirms it, so a
  // stray drag never spends a request.
  map.on("moveend", () => {
    animating = false;

    if (pendingPlaces) {
      drawPlaces();
    }

    if (pendingShowId) {
      const id = pendingShowId;
      pendingShowId = "";
      showPlace(id);
    }

    if (!props.center) {
      return;
    }

    // Measure drift in screen space from the *visible* centre - the part of the
    // map not hidden behind the sidebar - or a fit that pads for the sidebar
    // would itself count as "moved".
    const size = map.getSize();
    const visibleCentre = L.point((size.x + props.insetLeft) / 2, size.y / 2);
    const centrePx = map.latLngToContainerPoint(L.latLng(props.center.lat, props.center.lng));
    const visibleSpan = Math.min(size.x - props.insetLeft, size.y);
    moved.value = centrePx.distanceTo(visibleCentre) > visibleSpan * 0.3;
  });

  // Leaflet caches its container size; tell it whenever the pane actually
  // changes (window resize, dev-tools, an emulated viewport) and finish any fit
  // that was skipped because the container had not been laid out yet.
  resizeObserver = new ResizeObserver(() => {
    if (!map) {
      return;
    }

    map.invalidateSize({ animate: false });

    if (pendingFit && props.center) {
      pendingFit = false;
      fitToRadius(false);
    }
  });
  resizeObserver.observe(mapElement.value);

  drawCenter();
  drawRoute();
  drawPlaces();

  if (props.center) {
    fitToRadius(false);
  }
});

watch(
  () => [props.center?.lat, props.center?.lng, props.radius],
  () => {
    liveRadius.value = props.radius;
    drawCenter();
    fitToRadius(true);
    moved.value = false;
  }
);

watch(() => props.places, drawPlaces);
watch(() => props.routeLocations, drawRoute, { deep: true });

watch(
  () => [props.selectedPlaceId, props.hoveredPlaceId],
  ([selected, hovered], [prevSelected, prevHovered] = []) => {
    refreshPinState([...new Set([selected, hovered, prevSelected, prevHovered])]);
  }
);

/** Bring a place's pin into view and open its card. Waits for any running
 * animation first, and unfolds the cluster the pin may be hidden in. */
function showPlace(id) {
  const marker = markersByPlaceId.get(id);

  if (!marker || !map || !clusterLayer) {
    return;
  }

  if (isAnimating()) {
    pendingShowId = id;
    return;
  }

  if (marker._icon && map.getBounds().contains(marker.getLatLng())) {
    marker.openPopup();
    return;
  }

  clusterLayer.zoomToShowLayer(marker, () => {
    // The callback can land on the last animation frame; open on the next
    // tick so the popup is positioned against the settled map.
    setTimeout(() => marker.openPopup(), 0);
  });
}

watch(
  () => props.selectedPlaceId,
  (id) => {
    if (id) {
      showPlace(id);
    } else {
      map?.closePopup();
    }
  }
);

watch(
  () => props.insetLeft,
  () => {
    if (props.center) {
      fitToRadius(true);
    }
  }
);

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;

  if (map) {
    map.remove();
    map = null;
  }
});
</script>

<template>
  <div class="map-wrap">
    <div ref="mapElement" class="map" aria-label="Map of places"></div>

    <transition name="pop">
      <button v-if="moved" type="button" class="search-area-btn" @click="searchThisArea">
        <span aria-hidden="true">↻</span> Search this area
      </button>
    </transition>

    <div class="map-controls" role="group" aria-label="Map controls">
      <button type="button" class="map-ctl" aria-label="Zoom in" title="Zoom in" @click="zoomIn">+</button>
      <button type="button" class="map-ctl" aria-label="Zoom out" title="Zoom out" @click="zoomOut">−</button>
      <span class="map-ctl-gap"></span>
      <button
        type="button"
        class="map-ctl"
        :class="{ busy: locating }"
        aria-label="Use my location"
        title="Use my location"
        @click="emit('use-my-location')"
      >
        <span class="locate-glyph" aria-hidden="true"></span>
      </button>
      <button
        v-if="center"
        type="button"
        class="map-ctl"
        aria-label="Fit the search radius"
        title="Fit the search radius"
        @click="recentre"
      >
        ⤢
      </button>
    </div>

    <p v-if="!center" class="map-hint">Click anywhere on the map to start searching there.</p>
    <p v-else class="map-hint">Drag the blue dot to move the centre · drag the ring's handle to resize</p>
  </div>
</template>
