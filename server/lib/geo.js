const EARTH_RADIUS_METERS = 6371000;

export function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

export function haversineDistanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);

  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Bounding box that fully contains a circle of `radius` metres around a point.
 * Longitude degrees shrink with latitude, so scale them by cos(lat).
 */
export function boundingBox(lat, lng, radiusMeters) {
  const latDelta = (radiusMeters / EARTH_RADIUS_METERS) * (180 / Math.PI);
  const cosLat = Math.max(Math.cos(toRadians(lat)), 0.01);
  const lngDelta = latDelta / cosLat;

  return {
    minLat: clamp(lat - latDelta, -90, 90),
    maxLat: clamp(lat + latDelta, -90, 90),
    minLng: clamp(lng - lngDelta, -180, 180),
    maxLng: clamp(lng + lngDelta, -180, 180)
  };
}

/**
 * Split a bounding box into a grid of at most `maxCells` sub-boxes.
 * Used to work around per-request result caps on upstream search APIs:
 * one capped query per cell returns far more than one capped query for the
 * whole area.
 */
export function splitBoundingBox(box, columns, rows) {
  const cells = [];
  const latStep = (box.maxLat - box.minLat) / rows;
  const lngStep = (box.maxLng - box.minLng) / columns;

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      cells.push({
        minLat: box.minLat + row * latStep,
        maxLat: box.minLat + (row + 1) * latStep,
        minLng: box.minLng + column * lngStep,
        maxLng: box.minLng + (column + 1) * lngStep
      });
    }
  }

  return cells;
}

export function boxCenter(box) {
  return {
    lat: (box.minLat + box.maxLat) / 2,
    lng: (box.minLng + box.maxLng) / 2
  };
}

/**
 * Coverage tiles are ~0.01 degree squares (roughly 1.1 km). A search area is
 * "already scraped" when every tile it touches has a fresh coverage row.
 */
const TILE_DEGREES = 0.01;

export function tileKey(lat, lng) {
  const latIndex = Math.floor(lat / TILE_DEGREES);
  const lngIndex = Math.floor(lng / TILE_DEGREES);
  return `${latIndex}:${lngIndex}`;
}

export function tileKeysForBox(box) {
  const keys = new Set();
  const startLat = Math.floor(box.minLat / TILE_DEGREES);
  const endLat = Math.floor(box.maxLat / TILE_DEGREES);
  const startLng = Math.floor(box.minLng / TILE_DEGREES);
  const endLng = Math.floor(box.maxLng / TILE_DEGREES);

  for (let latIndex = startLat; latIndex <= endLat; latIndex += 1) {
    for (let lngIndex = startLng; lngIndex <= endLng; lngIndex += 1) {
      keys.add(`${latIndex}:${lngIndex}`);
    }
  }

  return Array.from(keys);
}
