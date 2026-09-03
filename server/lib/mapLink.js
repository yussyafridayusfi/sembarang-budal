import { fetchWithTimeout } from "./http.js";

/**
 * Resolving a pasted Google Maps / Google share link into a location.
 *
 * There are two quite different kinds of link, and the difference decides how
 * good an answer we can give:
 *
 * - **A Maps link** (`maps.app.goo.gl/…`, or a full `google.com/maps/place/…`
 *   URL) carries the coordinates in the URL itself. Following the redirect is
 *   enough, and the result is exact.
 * - **A Google Search share link** (`share.google/…`) does not. Measured on the
 *   two links this was reported with, both redirect to `google.com/search?q=…`,
 *   and the page Google serves to a non-browser client is a bot-check notice
 *   with no address and no coordinates anywhere in it. All that can honestly be
 *   recovered is the place *name* from the query string, which then has to be
 *   geocoded like any other text - and a bare name is often ambiguous
 *   ("Royal Plaza" geocodes to Lima, Peru).
 *
 * So this module reports how it resolved a link, and the caller is expected to
 * tell the user rather than presenting a guess as a pinpoint.
 */

/** Hosts that shorten or wrap a link and have to be followed to be read. */
const REDIRECT_HOSTS = new Set([
  "share.google",
  "maps.app.goo.gl",
  "goo.gl",
  "g.co",
  "maps.google.com",
  "www.google.com",
  "google.com"
]);

/** Hosts we will follow a redirect to. Anything else is not our business. */
function isGoogleHost(host) {
  return /(^|\.)(google\.[a-z.]+|goo\.gl|g\.co|share\.google)$/i.test(host);
}

export function findMapLink(text) {
  const match = String(text || "").match(/https?:\/\/[^\s<>"']+/i);

  if (!match) {
    return null;
  }

  try {
    const url = new URL(match[0]);
    return isGoogleHost(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

function validCoords(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    // 0,0 is what a malformed URL degrades to, and it is in the Atlantic.
    !(lat === 0 && lng === 0)
  );
}

/**
 * Pull coordinates out of a Maps URL.
 *
 * `!3d<lat>!4d<lng>` is preferred over `@<lat>,<lng>`: the first is the place
 * itself, the second is only where the map viewport happened to be, which can
 * be some way off when the link was made at a low zoom.
 */
export function parseCoordinatesFromUrl(rawUrl) {
  let url;

  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const full = url.toString();
  const pair = "(-?\\d+(?:\\.\\d+)?)";

  const ordered = [
    { re: new RegExp(`!3d${pair}!4d${pair}`), label: "place" },
    { re: new RegExp(`[?&](?:ll|sll|center|daddr|saddr)=${pair},\\s*${pair}`), label: "param" },
    { re: new RegExp(`[?&](?:q|query|destination)=${pair},\\s*${pair}`), label: "param" },
    { re: new RegExp(`/@${pair},${pair}`), label: "viewport" }
  ];

  for (const { re, label } of ordered) {
    const match = full.match(re);

    if (!match) {
      continue;
    }

    const lat = Number(match[1]);
    const lng = Number(match[2]);

    if (validCoords(lat, lng)) {
      return { lat, lng, from: label };
    }
  }

  return null;
}

function cleanName(value) {
  return String(value || "")
    .replace(/\+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The place name, when the URL carries one instead of coordinates. */
export function parsePlaceNameFromUrl(rawUrl) {
  let url;

  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const place = url.pathname.match(/\/maps\/place\/([^/@]+)/);

  if (place) {
    try {
      return cleanName(decodeURIComponent(place[1]));
    } catch {
      return cleanName(place[1]);
    }
  }

  // share.google links land on /search?q=<place name>.
  for (const key of ["q", "query", "destination"]) {
    const value = url.searchParams.get(key);

    if (value && !/^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(value)) {
      return cleanName(value);
    }
  }

  return null;
}

/**
 * Follow a short link far enough to read its final URL.
 *
 * Google serves a bot-check page to plain clients, so a browser-like
 * User-Agent is needed for the redirect to happen at all. The body is never
 * used - only `response.url` - so it is cancelled rather than downloaded.
 */
async function resolveRedirect(rawUrl, timeoutMs) {
  const response = await fetchWithTimeout(rawUrl, {
    timeoutMs,
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "id,en"
    }
  });

  try {
    await response.body?.cancel();
  } catch {
    // Nothing to clean up if the body was already consumed or absent.
  }

  return response.url || rawUrl;
}

/**
 * Resolve a pasted link as far as it can be resolved without guessing.
 *
 * Returns `{ kind: "coordinates", lat, lng, name }` when the link carried a
 * position, or `{ kind: "name", name }` when all it carried was a place name
 * for the caller to geocode. Throws only when the link could not be read at
 * all.
 */
export async function resolveMapLink(rawUrl, { timeoutMs = 10000 } = {}) {
  const direct = parseCoordinatesFromUrl(rawUrl);

  if (direct) {
    return {
      kind: "coordinates",
      lat: direct.lat,
      lng: direct.lng,
      name: parsePlaceNameFromUrl(rawUrl) || "",
      precision: direct.from,
      finalUrl: rawUrl
    };
  }

  const host = (() => {
    try {
      return new URL(rawUrl).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();

  const shouldFollow = REDIRECT_HOSTS.has(host) || isGoogleHost(host);
  const finalUrl = shouldFollow ? await resolveRedirect(rawUrl, timeoutMs) : rawUrl;

  const resolved = parseCoordinatesFromUrl(finalUrl);

  if (resolved) {
    return {
      kind: "coordinates",
      lat: resolved.lat,
      lng: resolved.lng,
      name: parsePlaceNameFromUrl(finalUrl) || "",
      precision: resolved.from,
      finalUrl
    };
  }

  const name = parsePlaceNameFromUrl(finalUrl);

  if (name) {
    return { kind: "name", name, finalUrl };
  }

  throw new Error(
    "That link does not contain a location. Open it in Google Maps, then use Share there and paste that link instead."
  );
}
