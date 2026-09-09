import { fetchWithTimeout } from "../http.js";
import { getStore } from "../db.js";
import { filterByRelevance } from "../addressQuery.js";

/**
 * Short videos about a place, for the detail sheet.
 *
 * YouTube is the one platform that answers a plain search request without a
 * login: the results page embeds `ytInitialData`, which lists ordinary videos
 * (`videoRenderer`) and Shorts (`shortsLockupViewModel`) for the query.
 * Instagram redirects every search to its login page and TikTok renders its
 * results client-side behind a signed API, so for those two the sheet gets a
 * search link the person can open themselves - not scraped content.
 *
 * Results are filtered by name relevance before they are shown: a search for a
 * small warung returns generic "kuliner Sidoarjo" videos too, and a video that
 * does not mention the place is not a video about the place.
 */
const RESULTS_URL = "https://www.youtube.com/results";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const HIT_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_VIDEOS = 3;

const str = (value) => (typeof value === "string" ? value.trim() : "");
const runs = (node) => (Array.isArray(node?.runs) ? node.runs.map((run) => str(run.text)).join("") : str(node?.simpleText));

/** Every `videoRenderer` and `shortsLockupViewModel` anywhere in the tree. */
function collectRenderers(root) {
  const videos = [];
  const shorts = [];

  (function walk(node) {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    if (!node || typeof node !== "object") {
      return;
    }

    if (node.videoRenderer) {
      videos.push(node.videoRenderer);
    } else if (node.shortsLockupViewModel) {
      shorts.push(node.shortsLockupViewModel);
    }

    Object.values(node).forEach(walk);
  })(root);

  return { videos, shorts };
}

function fromVideoRenderer(video) {
  const id = str(video.videoId);

  if (!id) {
    return null;
  }

  const description = (video.detailedMetadataSnippets || [])
    .map((snippet) => runs(snippet.snippetText))
    .join(" ");

  return {
    platform: "youtube",
    kind: "video",
    id,
    title: runs(video.title),
    description,
    channel: runs(video.ownerText) || runs(video.shortBylineText),
    views: runs(video.viewCountText),
    published: runs(video.publishedTimeText),
    duration: runs(video.lengthText),
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    url: `https://www.youtube.com/watch?v=${id}`
  };
}

function fromShort(short) {
  const id = str(short.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId);

  if (!id) {
    return null;
  }

  // "Mie Gacoan Puri Surya Jaya Sidoarjo #miegacoan, 1,2 ribu x ditonton - putar video Shorts"
  const label = str(short.accessibilityText);
  const viewsMatch = label.match(/,\s*([^,]*ditonton|[^,]*views)\s*-/i);
  const title = runs(short.overlayMetadata?.primaryText) || label.replace(/,\s*[^,]*(ditonton|views).*$/i, "");

  return {
    platform: "youtube",
    kind: "short",
    id,
    title,
    description: label,
    channel: "",
    views: viewsMatch ? viewsMatch[1].trim() : runs(short.overlayMetadata?.secondaryText),
    published: "",
    duration: "",
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    url: `https://www.youtube.com/shorts/${id}`
  };
}

/** Parse a YouTube results page into a list of candidate videos. */
export function parseSearchPage(html) {
  const match = html.match(/var ytInitialData = (\{[\s\S]*?\});<\/script>/);

  if (!match) {
    return [];
  }

  let data;

  try {
    data = JSON.parse(match[1]);
  } catch {
    return [];
  }

  const { videos, shorts } = collectRenderers(data);
  const seen = new Set();

  return [...videos.map(fromVideoRenderer), ...shorts.map(fromShort)].filter((item) => {
    if (!item || !item.title || seen.has(item.id)) {
      return false;
    }

    seen.add(item.id);
    return true;
  });
}

/**
 * Keep the videos that are about *this* place. `filterByRelevance` wants the
 * query's distinctive tokens (all of them for a short name, a majority for a
 * long one) to appear in the title or description.
 */
export function pickRelevant(candidates, name, area = "", limit = MAX_VIDEOS) {
  const relevant = filterByRelevance(
    candidates.map((video) => ({ ...video, name: video.title, displayName: video.description })),
    name
  );

  // Among the relevant ones, prefer a title that names more of the place and
  // its area: "Kopi Kenangan Royal Plaza" over a documentary about the brand,
  // the Gedangan branch over the Semarang one.
  // Distinct tokens per field, so a hashtag-stuffed caption that repeats
  // "sidoarjo" four times does not outrank a title that actually names the place.
  const tokens = (text) => [
    ...new Set(
      String(text)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 3)
    )
  ];
  const nameTokens = new Set(tokens(name));
  const areaTokens = new Set(tokens(area).filter((token) => !nameTokens.has(token)));
  const score = (video) => {
    const title = tokens(video.title);
    const description = tokens(video.description).filter((token) => !title.includes(token));
    const hits = (set, list, weight) => list.filter((token) => set.has(token)).length * weight;

    return hits(nameTokens, title, 3) + hits(areaTokens, title, 2) + hits(nameTokens, description, 1) + hits(areaTokens, description, 1);
  };

  return relevant
    .map((video, index) => ({ video, index, score: score(video) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ video: { name: _title, displayName: _description, ...video } }) => video);
}

/** Search links for the platforms that do not answer without a login. */
export function socialSearchLinks(query) {
  const encoded = encodeURIComponent(query);

  return [
    { platform: "tiktok", label: "TikTok", url: `https://www.tiktok.com/search?q=${encoded}` },
    { platform: "instagram", label: "Instagram", url: `https://www.instagram.com/explore/search/keyword/?q=${encoded}` },
    { platform: "youtube", label: "YouTube", url: `https://www.youtube.com/results?search_query=${encoded}` }
  ];
}

async function searchYouTube(query, timeoutMs) {
  const response = await fetchWithTimeout(`${RESULTS_URL}?search_query=${encodeURIComponent(query)}&hl=id&gl=ID`, {
    timeoutMs,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html",
      "Accept-Language": "id,en",
      // Skips the EU consent interstitial, which some edge nodes serve anyway.
      Cookie: "CONSENT=YES+; SOCS=CAI"
    }
  });

  if (!response.ok) {
    throw new Error(`youtube/results responded ${response.status}`);
  }

  return parseSearchPage(await response.text());
}

/**
 * Up to three videos about the place, plus search links. `area` is the town
 * or district, used only to steer the search; relevance is judged on `name`.
 * Throws when YouTube could not be reached, so the caller can say so.
 */
export async function fetchPlaceVideos({ name, area = "", timeoutMs = 8000 }) {
  const placeName = str(name);

  if (placeName.length < 3) {
    return { videos: [], links: socialSearchLinks(placeName) };
  }

  const query = [placeName, str(area)].filter(Boolean).join(" ");
  const key = `videos:v1:${query.toLowerCase()}`;
  const store = getStore();
  let cached = null;

  try {
    cached = store.getGeocode(key);
  } catch (error) {
    console.warn(`[videos] cache read failed: ${error.message}`);
  }

  if (cached) {
    const age = Date.now() - cached.updatedAt;
    const ttl = cached.payload?.length ? HIT_TTL_MS : MISS_TTL_MS;

    if (age < ttl) {
      return { videos: cached.payload || [], links: socialSearchLinks(query) };
    }
  }

  const candidates = await searchYouTube(query, timeoutMs);
  const videos = pickRelevant(candidates, placeName, str(area));

  try {
    store.saveGeocode(key, videos);
  } catch (error) {
    console.warn(`[videos] cache write failed: ${error.message}`);
  }

  return { videos, links: socialSearchLinks(query) };
}
