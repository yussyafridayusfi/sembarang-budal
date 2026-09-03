/**
 * Place categories exposed to the UI, each mapped to the OSM tags that define
 * it. Overpass queries are generated per category group so every request stays
 * small enough to answer inside its timeout - one giant multi-tag query is
 * what made the previous implementation return 504 for every search.
 */
export const CATEGORY_GROUPS = [
  {
    id: "food",
    label: "Food & drink",
    icon: "restaurant",
    tags: [
      ["amenity", ["restaurant", "fast_food", "food_court", "bbq", "canteen"]],
      ["shop", ["bakery", "pastry", "deli", "butcher"]]
    ],
    searchTerms: ["restoran", "rumah makan", "warung", "resto"]
  },
  {
    id: "cafe",
    label: "Cafe & bakery",
    icon: "cafe",
    tags: [
      ["amenity", ["cafe", "ice_cream", "juice_bar"]],
      ["shop", ["coffee", "tea"]]
    ],
    searchTerms: ["cafe", "kopi", "coffee", "kedai kopi"]
  },
  {
    id: "nightlife",
    label: "Bar & nightlife",
    icon: "bar",
    tags: [
      ["amenity", ["bar", "pub", "biergarten", "nightclub"]]
    ],
    searchTerms: ["bar", "lounge"]
  },
  {
    id: "shopping",
    label: "Shopping",
    icon: "shopping",
    tags: [
      ["shop", ["mall", "department_store", "supermarket", "convenience", "clothes", "electronics", "books", "shoes", "sports", "furniture", "jewelry", "variety_store"]],
      ["amenity", ["marketplace"]]
    ],
    searchTerms: ["mall", "pasar", "toko", "plaza"]
  },
  {
    id: "attraction",
    label: "Attractions",
    icon: "attraction",
    tags: [
      ["tourism", ["attraction", "museum", "gallery", "zoo", "theme_park", "viewpoint", "aquarium", "artwork", "picnic_site"]],
      ["historic", ["monument", "memorial", "castle", "ruins", "archaeological_site"]]
    ],
    searchTerms: ["wisata", "museum", "monumen", "taman wisata"]
  },
  {
    id: "outdoor",
    label: "Parks & outdoors",
    icon: "park",
    tags: [
      ["leisure", ["park", "garden", "nature_reserve", "water_park", "playground", "beach_resort", "pitch", "sports_centre", "swimming_pool"]],
      ["natural", ["beach", "peak", "waterfall", "hot_spring"]]
    ],
    searchTerms: ["taman", "pantai", "alun-alun", "hutan kota"]
  },
  {
    id: "entertainment",
    label: "Entertainment",
    icon: "entertainment",
    tags: [
      ["amenity", ["cinema", "theatre", "arts_centre", "community_centre", "casino"]],
      ["leisure", ["bowling_alley", "escape_game", "amusement_arcade", "fitness_centre"]]
    ],
    searchTerms: ["cinema", "bioskop", "karaoke", "gym"]
  },
  {
    id: "stay",
    label: "Hotels & stay",
    icon: "hotel",
    tags: [
      ["tourism", ["hotel", "hostel", "guest_house", "motel", "apartment", "resort", "camp_site"]]
    ],
    searchTerms: ["hotel", "penginapan", "villa", "homestay"]
  },
  {
    id: "worship",
    label: "Places of worship",
    icon: "worship",
    tags: [
      ["amenity", ["place_of_worship"]]
    ],
    searchTerms: ["masjid", "gereja", "pura", "klenteng", "vihara"]
  },
  {
    id: "essential",
    label: "Essentials",
    icon: "essential",
    tags: [
      ["amenity", ["hospital", "clinic", "pharmacy", "doctors", "bank", "atm", "fuel", "police", "post_office", "charging_station", "toilets"]]
    ],
    searchTerms: ["rumah sakit", "apotek", "bank", "pom bensin", "puskesmas"]
  },
  {
    id: "transport",
    label: "Transport",
    icon: "transport",
    tags: [
      ["public_transport", ["station"]],
      ["railway", ["station"]],
      ["amenity", ["bus_station", "ferry_terminal", "taxi"]],
      ["aeroway", ["terminal"]]
    ],
    searchTerms: ["stasiun", "terminal", "bandara", "pelabuhan"]
  },
  {
    id: "education",
    label: "Education",
    icon: "education",
    tags: [
      ["amenity", ["school", "university", "college", "library", "kindergarten"]]
    ],
    searchTerms: ["sekolah", "universitas", "kampus", "perpustakaan"]
  }
];

const CATEGORY_BY_ID = new Map(CATEGORY_GROUPS.map((group) => [group.id, group]));

/**
 * Reverse index from `${key}=${value}` to a category id, so a raw OSM element
 * can be labelled without re-scanning the taxonomy.
 */
const CATEGORY_BY_TAG = new Map();

CATEGORY_GROUPS.forEach((group) => {
  group.tags.forEach(([key, values]) => {
    values.forEach((value) => {
      const tagKey = `${key}=${value}`;
      if (!CATEGORY_BY_TAG.has(tagKey)) {
        CATEGORY_BY_TAG.set(tagKey, group.id);
      }
    });
  });
});

const DEFAULT_CATEGORY_IDS = ["food", "cafe", "shopping", "attraction", "outdoor"];

export function getCategory(id) {
  return CATEGORY_BY_ID.get(id) || null;
}

export function resolveCategoryIds(raw) {
  const requested = String(raw || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  if (!requested.length) {
    return [...DEFAULT_CATEGORY_IDS];
  }

  if (requested.includes("all")) {
    return CATEGORY_GROUPS.map((group) => group.id);
  }

  const valid = requested.filter((id) => CATEGORY_BY_ID.has(id));
  return valid.length ? valid : [...DEFAULT_CATEGORY_IDS];
}

/** Tag keys we consider when deciding whether an element is a real POI. */
const POI_KEYS = [
  "amenity",
  "shop",
  "tourism",
  "leisure",
  "historic",
  "natural",
  "public_transport",
  "railway",
  "aeroway",
  "office",
  "craft",
  "healthcare"
];

export function describeTags(tags = {}) {
  for (const key of POI_KEYS) {
    const value = tags[key];
    if (value) {
      return {
        key,
        value: String(value),
        categoryId: CATEGORY_BY_TAG.get(`${key}=${value}`) || "other"
      };
    }
  }

  return null;
}

export function categoryIdForTag(key, value) {
  return CATEGORY_BY_TAG.get(`${key}=${value}`) || "other";
}

export function publicCategories() {
  return CATEGORY_GROUPS.map(({ id, label, icon }) => ({ id, label, icon }));
}

/**
 * A category's tags in Photon's `key:value` filter syntax.
 *
 * Photon accepts a list of these in one request, so a category is a single
 * question with its own result slot. Asking by bare key instead (`osm_tag=
 * amenity`) shares one 50-result cap across every category that uses the key,
 * and the dense ones bury the rest.
 */
export function osmTagsForCategory(categoryId) {
  const group = CATEGORY_BY_ID.get(categoryId);

  if (!group) {
    return [];
  }

  const tags = [];
  group.tags.forEach(([key, values]) => {
    values.forEach((value) => tags.push(`${key}:${value}`));
  });

  return tags;
}
