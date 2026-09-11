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
  vehicle: "#0b7285",
  service: "#a05a2c",
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
  vehicle: "🛵",
  service: "🔧",
  other: "📍"
};

/**
 * Quick filters offered inside the results for a category, for the moment
 * someone is standing next to a flat tyre: "tambal ban", not "vehicle
 * repair, 112 places". Each matches on the place's OSM / Overture type and on
 * its name, because a tambal ban is usually tagged `shop=tyres` or not at all
 * and simply called "Tambal Ban".
 */
const has = (pattern) => (text) => pattern.test(String(text || ""));

export const QUICK_FILTERS = {
  vehicle: [
    {
      id: "motor",
      label: "Bengkel motor",
      icon: "🛵",
      match: (place) =>
        has(/motorcycle/)(place.tagValue) || has(/(bengkel motor|motor|ahass|yamaha|honda|suzuki|kawasaki|vespa)/i)(place.name)
    },
    {
      id: "mobil",
      label: "Bengkel mobil",
      icon: "🚗",
      match: (place) =>
        has(/^car_repair$|^car$|automotive|auto_(repair|body|glass|detailing|customization|restoration|parts)|car_parts/)(place.tagValue) ||
        has(/(bengkel mobil|mobil|auto ?care|toyota|daihatsu|mitsubishi|nissan|suzuki mobil)/i)(place.name)
    },
    {
      id: "ban",
      label: "Tambal ban",
      icon: "🛞",
      match: (place) => has(/tyre|tire/)(place.tagValue) || has(/tambal|ban|tyre|tire|velg/i)(place.name)
    },
    {
      id: "cuci",
      label: "Cuci kendaraan",
      icon: "🫧",
      match: (place) => has(/car_wash|detailing/)(place.tagValue) || has(/(cuci|wash|salon mobil|detailing)/i)(place.name)
    }
  ],
  service: [
    {
      id: "hp",
      label: "Servis HP & laptop",
      icon: "📱",
      match: (place) =>
        has(/mobile_phone|computer|electronics_repair|it_service|appliance/)(place.tagValue) ||
        has(/(hp|handphone|ponsel|laptop|komputer|elektronik|gadget)/i)(place.name)
    },
    {
      id: "laundry",
      label: "Laundry",
      icon: "🧺",
      match: (place) => has(/laundry|dry_clean/)(place.tagValue) || has(/laundry|laundromat/i)(place.name)
    },
    {
      id: "salon",
      label: "Salon & barber",
      icon: "💈",
      match: (place) =>
        has(/hairdresser|beauty|barber|salon|nail/)(place.tagValue) || has(/(salon|barber|pangkas|potong rambut|cukur)/i)(place.name)
    }
  ]
};

/** The phone a row can dial directly, when its source carried one. */
export function phoneOf(place) {
  const tags = place?.tags || {};
  return String(tags.phone || tags["contact:phone"] || tags["contact:mobile"] || "").trim();
}

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
