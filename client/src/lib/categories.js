/**
 * One place for how a category looks: its colour, its glyph, and how a place's
 * raw OSM type reads as a label. MapView, the results list, the chips and the
 * detail sheet all draw from here so a category is the same colour everywhere.
 */

export const CATEGORY_COLORS = {
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

export const CATEGORY_ICONS = {
  food: "🍜",
  cafe: "☕",
  nightlife: "🍸",
  shopping: "🛍️",
  attraction: "📸",
  outdoor: "🌳",
  entertainment: "🎬",
  stay: "🛏️",
  worship: "🕌",
  essential: "🏥",
  transport: "🚉",
  education: "🎓",
  other: "📍"
};

export function colorFor(categoryId) {
  return CATEGORY_COLORS[categoryId] || CATEGORY_COLORS.other;
}

export function iconFor(categoryId) {
  return CATEGORY_ICONS[categoryId] || CATEGORY_ICONS.other;
}

/**
 * A place whose only "name" is a street was an unnamed POI that an older
 * import labelled by its address. Show it as "Unnamed cafe" so nobody reads
 * "Jalan Garuda" as the name of a cafe.
 */
const STREET_LIKE = /^(jalan|jln?[.]?|gang|gg[.]?|blok)(?![a-z])/i;

export function typeLabel(place) {
  return String(place?.tagValue || place?.type || "place").replace(/_/g, " ");
}

export function displayName(place) {
  if (!place) {
    return "";
  }

  if (place.unnamed || STREET_LIKE.test(String(place.name || "").trim())) {
    return `Unnamed ${typeLabel(place)}`;
  }

  return place.name;
}

export function formatDistance(metres) {
  if (!Number.isFinite(metres)) {
    return "";
  }

  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(1)} km`;
}

/** ~80 m/min is a normal walking pace; ~400 m/min a city ride. */
export function walkingMinutes(metres) {
  return Math.max(1, Math.round(metres / 80));
}

export function ridingMinutes(metres) {
  return Math.max(1, Math.round(metres / 400));
}

export function formatRadius(metres) {
  if (metres >= 1000) {
    return `${(metres / 1000).toFixed(metres % 1000 === 0 ? 0 : 1)} km`;
  }

  return `${metres} m`;
}
