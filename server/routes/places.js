import express from "express";
import { discoverPlaces, storeStats } from "../lib/discovery.js";
import { publicCategories, resolveCategoryIds, describeTags } from "../lib/categories.js";
import { buildPlaceDetails } from "../lib/placeDetails.js";
import { clamp, haversineDistanceMeters, toNumber } from "../lib/geo.js";
import { reverseGeocode, searchPlaces } from "../lib/sources/nominatim.js";
import { searchPhoton } from "../lib/sources/photon.js";
import {
  buildQueryVariants,
  filterByRelevance,
  parseLatLngText,
  splitNameAndArea
} from "../lib/addressQuery.js";
import { findMapLink, resolveMapLink } from "../lib/mapLink.js";
import { fetchJson } from "../lib/http.js";

const router = express.Router();

/** Free-form radius, matching how a maps app works, but bounded so a single
 * request cannot ask for an area we could never cover. */
const MIN_RADIUS = 200;
const MAX_RADIUS = 30000;

/** Optional country restriction. Empty by default - the previous hard-coded
 * Indonesia-only filter rejected valid searches with a confusing error. */
const COUNTRY_CODES = process.env.PLACES_COUNTRY_CODES || "";

/** Optional. Set it and a name off a Google share link resolves through Google
 * itself, which is the only source guaranteed to have the place the link meant. */
const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY || "";

router.get("/categories", (req, res) => {
  res.json({ categories: publicCategories() });
});

router.get("/stats", (req, res) => {
  res.json(storeStats());
});

/** A soft bias box around a point - roughly 55 km, wide enough to cover a
 * metro area without excluding the next city. */
function biasBox(near) {
  if (!near) {
    return null;
  }

  return {
    minLat: near.lat - 0.5,
    maxLat: near.lat + 0.5,
    minLng: near.lng - 0.5,
    maxLng: near.lng + 0.5
  };
}

/** Nominatim's own results, used as the autocomplete fallback. */
async function nominatimSuggestions(query, near = null) {
  const results = await searchPlaces(query, {
    limit: 20,
    countryCodes: COUNTRY_CODES,
    timeoutMs: 8000,
    viewbox: biasBox(near),
    // Bias, never restrict: a place just outside the box should still be found.
    bounded: false
  });

  return results
    .map((item) => {
      const lat = Number(item.lat);
      const lng = Number(item.lon);

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return null;
      }

      const tagKey = item.category || item.class || "";
      const tagValue = item.type || "";

      return {
        name: item.name || item.display_name?.split(",")[0] || query,
        displayName: item.display_name || "",
        lat,
        lng,
        osmId: item.osm_id || "",
        osmType: item.osm_type || "",
        category: tagKey,
        type: tagValue,
        categoryId: describeTags({ [tagKey]: tagValue })?.categoryId || "other",
        source: "nominatim"
      };
    })
    .filter(Boolean);
}

/**
 * Resolve a name through Google Places, when a key is configured.
 *
 * A name that came off a Google share link is a Google place, so Google will
 * resolve it exactly - whereas OSM may simply not have it. "MPM Learning Center
 * - Sidoarjo" has no OSM entry at all, so without this the best OSM can do is
 * an unrelated near-miss. Optional: no key, no call, and the OSM path stands.
 */
async function googlePlaceSuggestions(name, near) {
  if (!GOOGLE_API_KEY || !name) {
    return [];
  }

  const params = new URLSearchParams({ query: name, key: GOOGLE_API_KEY });

  if (near) {
    params.set("location", `${near.lat},${near.lng}`);
    params.set("radius", "50000");
  }

  const data = await fetchJson(
    `https://maps.googleapis.com/maps/api/place/textsearch/json?${params.toString()}`,
    { timeoutMs: 6000, label: "google/textsearch" }
  );

  return (data.results || [])
    .map((item) => {
      const lat = Number(item.geometry?.location?.lat);
      const lng = Number(item.geometry?.location?.lng);

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return null;
      }

      return {
        name: String(item.name || name),
        displayName: item.formatted_address ? `${item.name} — ${item.formatted_address}` : String(item.name || name),
        lat,
        lng,
        osmId: "",
        osmType: "",
        category: "",
        type: "",
        categoryId: "other",
        source: "google-places"
      };
    })
    .filter(Boolean);
}

/** `near=lat,lng` - an optional point to bias results towards. */
function parseNear(raw) {
  const parts = String(raw || "").split(",");

  if (parts.length !== 2) {
    return null;
  }

  const lat = toNumber(parts[0]);
  const lng = toNumber(parts[1]);

  if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }

  return { lat, lng };
}

/** What the UI needs to explain how a pasted link was read. */
function linkInfo(resolved) {
  return {
    kind: resolved.kind,
    name: resolved.name || "",
    // "place" is the pin itself; "viewport" is only where the map was centred,
    // which can sit a little off the place at low zoom.
    precision: resolved.precision || null
  };
}

/** Turn resolved coordinates into a suggestion, labelled by reverse geocoding
 * where possible - the link gives a position, not an address. */
async function describePoint(resolved, source = "google-link") {
  const fallback = `${resolved.lat.toFixed(5)}, ${resolved.lng.toFixed(5)}`;
  let displayName = resolved.name || "";

  try {
    const place = await reverseGeocode(resolved.lat, resolved.lng, { timeoutMs: 6000 });
    const label = place?.display_name || "";

    if (label) {
      displayName = resolved.name ? `${resolved.name} — ${label}` : label;
    }
  } catch {
    // A missing label must not lose the coordinates, which are the point.
  }

  return {
    name: resolved.name || displayName.split(",")[0] || "Shared location",
    displayName: displayName || fallback,
    lat: resolved.lat,
    lng: resolved.lng,
    osmId: "",
    osmType: "",
    category: "",
    type: "",
    categoryId: "other",
    source
  };
}

/**
 * Location autocomplete.
 *
 * Photon answers first: it has no rate-limit queue, so a suggestion list comes
 * back in well under a second even while a place search is running. On
 * Nominatim every autocomplete request queued behind the browse requests that
 * share its one-request-per-second policy, so typing produced a spinner that
 * outlived the keystroke.
 *
 * Deliberately does NOT filter by OSM class. The old implementation kept only
 * an allowlist of classes, which silently dropped every city, district and
 * village (those are `boundary=administrative`) - typing "Surabaya" returned
 * zero suggestions.
 */
router.get("/search", async (req, res) => {
  let query = String(req.query.query || "").trim();

  if (query.length < 2) {
    return res.json({ suggestions: [] });
  }

  const near = parseNear(req.query.near);

  // A pasted coordinate pair is already the answer. This is the exact, free way
  // to pin a place no geocoder holds: right-click it in Google Maps and the
  // first menu item copies "-7.389, 112.728".
  const pastedPoint = parseLatLngText(query);

  if (pastedPoint) {
    return res.json({
      suggestions: [await describePoint({ ...pastedPoint, name: "" }, "coordinates")],
      link: null,
      matchedQuery: null,
      approximateArea: null
    });
  }

  // A pasted Google link is a location, not a search term - resolve it rather
  // than sending the URL itself to a geocoder, which matches nothing.
  const link = findMapLink(query);
  let linkContext = null;

  if (link) {
    let resolved;

    try {
      resolved = await resolveMapLink(link, { timeoutMs: 10000 });
    } catch (error) {
      return res.status(422).json({ error: error.message });
    }

    if (resolved.kind === "coordinates") {
      return res.json({ suggestions: [await describePoint(resolved)], link: linkInfo(resolved) });
    }

    // Only a name came back. Geocode it like ordinary text, and tell the caller
    // that is what happened - a name off a share link is frequently ambiguous,
    // so this must not be presented as if the link pinpointed the place.
    linkContext = resolved;
    query = resolved.name;

    // Google knows its own places; try it before falling back to OSM.
    try {
      const viaGoogle = await googlePlaceSuggestions(resolved.name, near);

      if (viaGoogle.length) {
        return res.json({ suggestions: viaGoogle.slice(0, 12), link: linkInfo(resolved) });
      }
    } catch (error) {
      console.warn(`[search] Google place lookup failed: ${error.message}`);
    }
  }

  // Progressively coarser versions of what was typed. A query that works costs
  // one request; only one that finds nothing pays for the fallbacks.
  // A link gives a proper name, and truncating a proper name matches the wrong
  // place confidently - so relaxation is limited to normalisation there.
  const variants = buildQueryVariants(query, { dropTokens: !linkContext });

  /**
   * Try each variant against one source, stopping at the first that answers.
   *
   * `completed` records that the source actually answered, even if it answered
   * with nothing. That distinction is the difference between "there is no such
   * place" and "we could not ask" - conflating them reported a lookup outage
   * for every genuinely unknown name whenever the primary source was down.
   */
  async function firstMatch(lookup) {
    let lastError = null;
    let completed = false;

    for (const variant of variants) {
      try {
        const found = await lookup(variant);
        completed = true;

        // A fuzzy source will answer an unknown name with a global near-miss.
        // Drop anything sharing no identifying token with what was asked.
        const relevant = filterByRelevance(found, variant);

        if (relevant.length) {
          return { suggestions: relevant, matchedQuery: variant, error: null, completed: true };
        }
      } catch (error) {
        lastError = error;
        // A source that is down fails the same way for every variant, so stop
        // rather than spending the user's time proving it four times over.
        break;
      }
    }

    return { suggestions: [], matchedQuery: null, error: lastError, completed };
  }

  /** `firstMatch` over an explicit variant list rather than the request's. */
  async function firstMatchOver(list, lookup) {
    for (const variant of list) {
      try {
        const relevant = filterByRelevance(await lookup(variant), variant);

        if (relevant.length) {
          return relevant;
        }
      } catch {
        // Fall through - an area we cannot resolve is simply no fallback.
      }
    }

    return [];
  }

  /** Photon, then Nominatim - used for the area fallback, which is one shot. */
  async function lookupBothSources(text, bias) {
    try {
      const viaPhoton = await searchPhoton(text, {
        limit: 10,
        countryCodes: COUNTRY_CODES,
        timeoutMs: 6000,
        near: bias
      });

      if (viaPhoton.length) {
        return viaPhoton;
      }
    } catch {
      // Photon being down is not a reason to skip Nominatim.
    }

    return nominatimSuggestions(text, bias);
  }

  let result = await firstMatch((variant) =>
    searchPhoton(variant, { limit: 15, countryCodes: COUNTRY_CODES, timeoutMs: 6000, near })
  );

  // Fall back rather than fail: Photon may be unreachable, and it indexes fewer
  // administrative boundaries than Nominatim, so an empty answer from it is not
  // evidence that the place does not exist.
  if (!result.suggestions.length) {
    const viaNominatim = await firstMatch((variant) => nominatimSuggestions(variant, near));

    // Prefer Nominatim's answer whenever it managed to give one - an empty
    // answer from a source that worked beats an error from one that did not.
    if (viaNominatim.suggestions.length || viaNominatim.completed) {
      result = viaNominatim;
    }
  }

  // Only a genuine outage is an error. "Nothing found" is a valid answer, and
  // the client renders it as one.
  if (!result.suggestions.length && result.error && !result.completed) {
    return res.status(502).json({
      error: `Address lookup is unavailable right now (${result.error.message}).`
    });
  }

  // A link named a place we cannot find. The name usually ends with its area
  // ("MPM Learning Center - Sidoarjo"), and that area still locates it well
  // enough to choose a meeting point - as long as it is presented as the
  // approximation it is, not as the place itself.
  let approximateArea = null;

  if (!result.suggestions.length && linkContext) {
    const { area } = splitNameAndArea(linkContext.name);

    if (area) {
      const viaArea = await firstMatchOver([area], (variant) => lookupBothSources(variant, near));

      if (viaArea.length) {
        result = { ...result, suggestions: viaArea, error: null, completed: true };
        approximateArea = area;
      }
    }
  }

  // With a bias point, order by distance from it. Photon ranks by its own
  // notion of relevance, which for a name shared by several places puts them in
  // an order that looks arbitrary to someone who meant the one near them -
  // "Royal Plaza" listed Surabaya, then Lima, then Hargeisa.
  const ordered = near
    ? [...result.suggestions].sort(
        (a, b) =>
          haversineDistanceMeters(near.lat, near.lng, a.lat, a.lng) -
          haversineDistanceMeters(near.lat, near.lng, b.lat, b.lng)
      )
    : result.suggestions;

  // Set only when the query was genuinely relaxed, so the UI can say so rather
  // than silently answering a different question than the one that was asked.
  // Compared against the first variant, not the raw input: variant one differs
  // from `query` by stray punctuation alone, which is not worth reporting.
  const relaxed = result.matchedQuery && result.matchedQuery !== variants[0];

  return res.json({
    suggestions: ordered.slice(0, 12),
    matchedQuery: relaxed ? result.matchedQuery : null,
    link: linkContext ? linkInfo(linkContext) : null,
    // The place itself was not found; this is its surrounding area.
    approximateArea
  });
});

/** Turn a coordinate into a label - used for "use my location" and map clicks. */
router.get("/reverse", async (req, res) => {
  const lat = toNumber(req.query.lat);
  const lng = toNumber(req.query.lng);

  if (lat === null || lng === null) {
    return res.status(400).json({ error: "lat and lng are required numeric values." });
  }

  try {
    const result = await reverseGeocode(lat, lng, { timeoutMs: 8000 });

    return res.json({
      lat,
      lng,
      name: result?.name || result?.display_name?.split(",")[0] || "Selected point",
      displayName: result?.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`
    });
  } catch (error) {
    // A failed label must not block the search - the coordinate is what matters.
    return res.json({
      lat,
      lng,
      name: "Selected point",
      displayName: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      warning: error.message
    });
  }
});

/**
 * The core endpoint: everything to go to within `radius` of a point.
 */
router.get("/places/nearby", async (req, res) => {
  const lat = toNumber(req.query.lat);
  const lng = toNumber(req.query.lng);
  const requestedRadius = toNumber(req.query.radius);

  if (lat === null || lng === null) {
    return res.status(400).json({ error: "lat and lng are required numeric values." });
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: "lat must be within -90..90 and lng within -180..180." });
  }

  const radius = clamp(requestedRadius === null ? 2000 : requestedRadius, MIN_RADIUS, MAX_RADIUS);
  const categoryIds = resolveCategoryIds(req.query.categories);
  const limit = clamp(toNumber(req.query.limit) ?? 200, 1, 500);

  try {
    const result = await discoverPlaces({
      lat,
      lng,
      radius,
      categoryIds,
      query: String(req.query.q || ""),
      limit,
      refresh: String(req.query.refresh || "") === "1"
    });

    return res.json(result);
  } catch (error) {
    return res.status(502).json({ error: error.message || "Failed to search for places." });
  }
});

/**
 * Backwards-compatible aliases for the previous endpoints, which only accepted
 * radii of exactly 1000/3000/5000.
 */
router.get("/places/center", (req, res) => {
  const params = new URLSearchParams({
    lat: String(req.query.lat || ""),
    lng: String(req.query.lng || ""),
    radius: String(req.query.radius || 2000),
    categories: String(req.query.categories || "")
  });

  res.redirect(307, `/api/places/nearby?${params.toString()}`);
});

router.get("/places/middle", (req, res) => {
  const params = new URLSearchParams({
    lat: String(req.query.lat || ""),
    lng: String(req.query.lng || ""),
    radius: String(req.query.radius || 2000),
    categories: String(req.query.categories || "")
  });

  res.redirect(307, `/api/places/nearby?${params.toString()}`);
});

router.get("/place/details", async (req, res) => {
  const lat = toNumber(req.query.lat);
  const lng = toNumber(req.query.lng);
  const id = String(req.query.id || "").trim();

  if (!id && (lat === null || lng === null)) {
    return res.status(400).json({ error: "Either id, or lat and lng, are required." });
  }

  try {
    const detail = await buildPlaceDetails({
      id,
      lat,
      lng,
      name: String(req.query.name || "").trim(),
      type: String(req.query.type || "").trim()
    });

    return res.json(detail);
  } catch (error) {
    return res.status(502).json({ error: error.message || "Failed to load place details." });
  }
});

export default router;
