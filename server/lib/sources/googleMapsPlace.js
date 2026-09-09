import { fetchWithTimeout } from "../http.js";
import { getStore } from "../db.js";
import { GOOGLE_USER_AGENT, scheduleGoogleRequest } from "./googleMaps.js";

/**
 * The public Google Maps *listing* of a place - what a person sees when they
 * open it in Maps - read without an API key.
 *
 * The embed card (`googleMaps.js`) stops at rating, count, phone, website and
 * hours. Everything else on the listing - photos, price range, review texts,
 * the popular-times chart, the "Opsi layanan / Suasana / Pembayaran / Parkir"
 * attribute groups, review topics - is served by the same RPC the Maps web
 * client calls when it renders the place panel: `/maps/preview/place`, keyed by
 * the place's feature id (`0x…:0x…`) that the embed card already gave us.
 *
 * Measured facts about that endpoint, September 2026:
 *
 * - It needs the cookies a plain `/maps` page load sets (NID and friends).
 *   Without them the same URL answers an 18 KB stub: rating, but no count, no
 *   reviews, no price, no attributes. With them: 180-300 KB with everything.
 *   The `!14m3!1s<token>` session field in `pb` does not matter.
 * - A freshly issued cookie is not trusted yet. Measured with the same URL and
 *   headers: 0 s after the landing page → the stub; 1.5 s → count and reviews
 *   but no price or attributes; 3 s → everything. So the jar is warmed at
 *   startup and a request waits until its cookie is old enough.
 * - Only `User-Agent`, `Accept-Language` and `Cookie` are sent. An explicit
 *   `Accept`, a `Referer` or the Sec-Fetch-* set made Google trim the payload.
 * - The response is `)]}'` followed by a JSON array; the place sits at `[6]`,
 *   and its fields are positional. The indexes used below were mapped against
 *   a mall, a coffee chain outlet and a noodle restaurant; anything that does
 *   not match the expected shape reads as "unknown", never as a guess.
 * - Photo URLs are `lh3.googleusercontent.com/...=w86-h86-k-no`; the size
 *   suffix is free to change, so no proxy is needed.
 *
 * This is automated access to Google Maps content, which Google's terms
 * restrict. It is one request per place a person actually opened, cached for
 * days, serialised and spaced with the embed requests, and switched off with
 * the same GOOGLE_MAPS_RESOLVER=0. Nothing here is bulk collection.
 */
const PREVIEW_URL = "https://www.google.com/maps/preview/place";
const LANDING_URL = "https://www.google.com/maps?hl=id";

const HIT_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 6 * 60 * 60 * 1000;
const COOKIE_TTL_MS = 6 * 60 * 60 * 1000;

/** How old a cookie must be before Google serves the full listing with it. */
const COOKIE_WARMUP_MS = 3500;

/** Bumped when the parsed shape changes, so older cache rows are re-read. */
const LISTING_VERSION = 2;

const MAX_PHOTOS = 10;
const MAX_REVIEWS = 8;

let cookieJar = { header: "", fetchedAt: 0 };
let cookieRefresh = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function refreshCookies() {
  const response = await fetchWithTimeout(LANDING_URL, {
    timeoutMs: 8000,
    redirect: "manual",
    headers: { "User-Agent": GOOGLE_USER_AGENT, Accept: "text/html", "Accept-Language": "id,en" }
  });

  const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  const header = cookies.map((cookie) => cookie.split(";")[0]).join("; ");

  if (!header) {
    throw new Error("google-maps/landing set no cookies");
  }

  cookieJar = { header, fetchedAt: Date.now() };
  return cookieJar;
}

/** The jar, refreshed when empty or stale. Concurrent callers share one refresh. */
async function getCookieJar({ force = false } = {}) {
  if (!force && cookieJar.header && Date.now() - cookieJar.fetchedAt < COOKIE_TTL_MS) {
    return cookieJar;
  }

  if (!cookieRefresh) {
    cookieRefresh = refreshCookies().finally(() => {
      cookieRefresh = null;
    });
  }

  return cookieRefresh;
}

/** A cookie usable for a full listing: fetched if needed, then aged. */
async function getWarmCookies({ force = false } = {}) {
  const jar = await getCookieJar({ force });
  const age = Date.now() - jar.fetchedAt;

  if (age < COOKIE_WARMUP_MS) {
    await sleep(COOKIE_WARMUP_MS - age);
  }

  return jar.header;
}

/** Fetch the cookies at server start so the first opened place does not pay
 * the warm-up wait. A failure here only means that request fetches them. */
export function warmGoogleMapsCookies() {
  return getCookieJar().then(
    () => true,
    (error) => {
      console.warn(`[google-maps] cookie warm-up failed: ${error.message}`);
      return false;
    }
  );
}

/**
 * The `pb` the Maps web client sends for a place panel, with the feature id
 * and coordinates filled in. The long tail of `!…b1` flags is what asks for
 * the review, photo, attribute and popular-times sections.
 */
function buildPb(featureId, lat, lng) {
  return (
    `!1m14!1s${featureId}!3m12!1m3!1d1000!2d${lng}!3d${lat}!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1` +
    `!12m4!2m3!1i360!2i120!4i8!13m57!2m2!1i203!2i100!3m2!2i4!5b1!6m6!1m2!1i86!2i86!1m2!1i408!2i240` +
    `!7m33!1m3!1e1!2b0!3e3!1m3!1e2!2b1!3e2!1m3!1e2!2b0!3e3!1m3!1e8!2b0!3e3!1m3!1e10!2b0!3e3!1m3!1e10!2b1!3e2!1m3!1e10!2b0!3e4!1m3!1e9!2b1!3e2!2b1!9b0` +
    `!15m8!1m7!1m2!1m1!1e2!2m2!1i195!2i195!3i20!14m3!1sX!7e81!15i10112` +
    `!15m108!1m26!13m9!2b1!3b1!4b1!6i1!8b1!9b1!14b1!20b1!25b1!18m15!3b1!4b1!5b1!6b1!13b1!14b1!17b1!21b1!22b1!30b1!32b1!33m1!1b1!34b1!36e2!10m1!8e3!11m1!3e1!17b1!20m2!1e3!1e6!24b1!25b1!26b1!27b1!29b1!30m1!2b1!36b1!37b1!39m3!2m2!2i1!3i1!43b1!52b1!54m1!1b1!55b1!56m1!1b1!61m2!1m1!1e1!65m5!3m4!1m3!1m2!1i224!2i298` +
    `!72m22!1m8!2b1!5b1!7b1!12m4!1b1!2b1!4m1!1e1!4b1!8m10!1m6!4m1!1e1!4m1!1e3!4m1!1e4!3sother_user_google_review_posts__and__hotel_and_vr_partner_review_posts!6m1!1e1!9b1!89b1!90m2!1m1!1e2!98m3!1b1!2b1!3b1!103b1!113b1!114m3!1b1!2m1!1b1!117b1!122m1!1b1!126b1!127b1!128m1!1b1` +
    `!21m0!22m1!1e81!30m8!3b1!6m2!1b1!2b1!7m2!1e3!2b1!9b1!34m5!7b1!10b1!14b1!15m1!1b0!37i793`
  );
}

const str = (value) => (typeof value === "string" ? value.trim() : "");
const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const arr = (value) => (Array.isArray(value) ? value : []);

/** `…=w86-h86-k-no` → the size we want. Google honours any w/h here. */
export function sizePhotoUrl(url, width, height = width) {
  if (!/^https:\/\/lh\d\.googleusercontent\.com\//.test(url)) {
    return url;
  }

  return url.replace(/=[^=]*$/, "") + `=w${width}-h${height}-k-no`;
}

function parsePhotos(place, name) {
  const seen = new Set();
  const photos = [];

  // [72] is the panel's photo strip, [51] the category covers behind it.
  for (const bucket of [place[72], place[51]]) {
    for (const item of arr(bucket?.[0])) {
      const url = str(item?.[6]?.[0]);
      const kind = str(item?.[20]);

      if (!/^https:\/\/lh\d\.googleusercontent\.com\//.test(url) || kind === "Video" || /=m\d+$/.test(url)) {
        continue;
      }

      const key = url.replace(/=[^=]*$/, "");

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      photos.push({
        url: sizePhotoUrl(url, 1200, 900),
        thumb: sizePhotoUrl(url, 240, 240),
        caption: str(item?.[6]?.[1]) && str(item[6][1]) !== name ? str(item[6][1]) : ""
      });

      if (photos.length >= MAX_PHOTOS) {
        return photos;
      }
    }
  }

  return photos;
}

function parseReviews(block) {
  const list = arr(block?.[9]?.[0]?.[0]);
  const reviews = [];

  for (const entry of list) {
    const review = entry?.[0];

    if (!Array.isArray(review)) {
      continue;
    }

    const meta = arr(review[1]);
    const body = arr(review[2]);
    const author = arr(meta[4]?.[5]);
    const micros = num(meta[2]);

    const photos = arr(body[2])
      .map((photo) => str(photo?.[1]?.[6]?.[0]))
      .filter((url) => /^https:\/\/lh\d\.googleusercontent\.com\//.test(url) && !/=m\d+$/.test(url))
      .slice(0, 4)
      .map((url) => sizePhotoUrl(url, 320, 320));

    const item = {
      author: str(author[0]) || "Google user",
      authorPhoto: str(author[1]),
      authorUrl: str(author[2]?.[0]),
      rating: num(body[0]?.[0]),
      text: str(body[15]?.[0]?.[0]),
      relativeTime: str(meta[6]),
      publishTime: micros && micros > 1e12 ? new Date(micros / 1000).toISOString() : "",
      ownerReply: str(review[3]?.[14]?.[0]?.[0]),
      photos
    };

    if (item.rating || item.text) {
      reviews.push(item);
    }

    if (reviews.length >= MAX_REVIEWS) {
      break;
    }
  }

  return reviews;
}

function parseAttributeGroups(node) {
  return arr(node?.[1])
    .map((group) => ({
      id: str(group?.[0]),
      label: str(group?.[1]),
      items: arr(group?.[2])
        .map((attribute) => {
          const flag = num(attribute?.[2]?.[0]);
          // flag 1 = yes, 0 = no, 2 = a chosen answer ("Banyak tempat parkir").
          const answer = flag === 2 ? str(attribute?.[2]?.[3]?.[2]) || str(attribute?.[2]?.[3]?.[3]) : "";

          return {
            id: str(attribute?.[0]),
            label: str(attribute?.[1]),
            value: flag === 1 ? true : flag === 0 ? false : null,
            answer,
            sentence: str(attribute?.[2]?.[2]?.[3])
          };
        })
        .filter((attribute) => attribute.label)
    }))
    .filter((group) => group.label && group.items.length);
}

/**
 * Popular times: seven days of hourly busyness (0-100), Google's own label per
 * hour, and - where Google has it - a waiting-time sentence per day. Day
 * indexes follow the hours table: 1 = Senin … 7 = Minggu.
 */
function parsePopularTimes(node) {
  const days = arr(node?.[0])
    .map((day) => ({
      dayIndex: num(day?.[0]),
      hours: arr(day?.[1])
        .map((hour) => ({ hour: num(hour?.[0]), busy: num(hour?.[1]) ?? 0, label: str(hour?.[2]) }))
        .filter((hour) => hour.hour !== null),
      waitText: str(day?.[3]?.[0])
    }))
    .filter((day) => day.dayIndex && day.hours.length);

  if (!days.length) {
    return null;
  }

  return {
    days,
    // "Tidak terlalu ramai" right now, when Google shows a live reading.
    liveLabel: str(node?.[5]),
    liveBusy: num(node?.[6]?.[1])
  };
}

function parseHours(node) {
  const hours = arr(node?.[0])
    .map((day) => {
      const ranges = arr(day?.[3])
        .map((range) => str(range?.[0]))
        .filter(Boolean);

      return { day: str(day?.[0]), dayIndex: num(day?.[1]), text: ranges.length ? ranges.join(", ") : "Tutup" };
    })
    .filter((day) => day.day && day.dayIndex);

  hours.sort((a, b) => a.dayIndex - b.dayIndex);

  const statusText = str(node?.[1]?.[4]?.[0]);

  return { hours, statusText, openNow: statusText ? /^(Buka|Open)/.test(statusText) : null };
}

/** "Pesan online" style links: any `[label, [..., [url]]]` pair under [75]. */
function parseOrderLinks(node) {
  const links = [];

  (function walk(value, depth) {
    if (!Array.isArray(value) || depth > 8 || links.length >= 4) {
      return;
    }

    const label = str(value[0]);
    const url = str(value[1]?.[2]?.[0]);

    if (label && /^https?:\/\//.test(url)) {
      links.push({ label, url });
      return;
    }

    value.forEach((child) => walk(child, depth + 1));
  })(node, 0);

  return links;
}

/** The place record at `[6]` of the RPC payload, read into named fields. */
export function parseListing(payload) {
  const place = payload?.[6];

  if (!Array.isArray(place) || !str(place[11])) {
    return null;
  }

  const name = str(place[11]);
  const ratingBlock = arr(place[4]);
  const priceVotes = arr(ratingBlock[9]?.[0])
    .map((entry) => ({
      label: str(entry?.[0]?.[1]),
      votes: num(entry?.[1]?.[0]) ?? 0,
      share: num(entry?.[1]?.[1]) ?? 0
    }))
    .filter((entry) => entry.label);

  const reviewsBlock = arr(place[175]);
  const histogram = arr(reviewsBlock[3]).map((count) => num(count) ?? 0);
  const { hours, statusText, openNow } = parseHours(place[203]);

  return {
    version: LISTING_VERSION,
    googleId: str(place[10]),
    placeId: str(place[78]),
    name,
    address: str(place[39]) || str(place[18]),
    addressLines: arr(place[2]).map(str).filter(Boolean),
    lat: num(place[9]?.[2]),
    lng: num(place[9]?.[3]),
    categoryLabels: arr(place[13]).map(str).filter(Boolean),
    website: str(place[7]?.[0]),
    phone: str(place[178]?.[0]?.[0]),
    phoneInternational: str(place[178]?.[0]?.[1]?.[1]?.[0]),
    rating: num(ratingBlock[7]),
    reviewCount: num(ratingBlock[8]),
    ratingHistogram: histogram.length === 5 ? histogram : null,
    price: str(ratingBlock[2])
      ? { label: str(ratingBlock[2]), perPerson: str(ratingBlock[10]), votes: priceVotes }
      : null,
    photos: parsePhotos(place, name),
    reviews: parseReviews(reviewsBlock),
    // Google's own pull-quotes for the listing.
    snippets: arr(place[31]?.[1])
      .map((snippet) => str(snippet?.[1]).replace(/^"|"$/g, ""))
      .filter(Boolean),
    // "tempat duduk · 7", "baristanya · 11" - what reviews talk about.
    topics: arr(place[153]?.[0])
      .map((topic) => ({ label: str(topic?.[1]), count: num(topic?.[3]?.[4]) ?? 0 }))
      .filter((topic) => topic.label && topic.count > 0)
      .slice(0, 12),
    attributeGroups: parseAttributeGroups(place[100]),
    popularTimes: parsePopularTimes(place[84]),
    openingHours: hours,
    statusText,
    openNow,
    editorial: str(place[32]?.[1]?.[1]) || str(place[32]?.[0]?.[1]),
    about: str(place[154]?.[0]?.[0]),
    locatedIn: str(place[134]?.[0]?.[0]?.[0]?.[0])
      ? { name: str(place[134][0][0][0][0]), googleId: str(place[134][0][0][0][1]) }
      : null,
    orderLinks: parseOrderLinks(place[75]),
    fetchedAt: Date.now()
  };
}

/** A payload Google trimmed for a cookie-less client: rating but no count. */
function looksThin(listing) {
  return Boolean(listing && listing.rating !== null && listing.reviewCount === null && !listing.reviews.length);
}

async function fetchListing(featureId, lat, lng, timeoutMs) {
  let cookie = await getWarmCookies();

  const request = async () => {
    // Exactly these three headers (see the header comment); not through
    // fetchWithTimeout, whose default `Accept` triggers the stub.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;

    try {
      response = await fetch(`${PREVIEW_URL}?authuser=0&hl=id&gl=id&pb=${buildPb(featureId, lat, lng)}`, {
        signal: controller.signal,
        headers: {
          "User-Agent": GOOGLE_USER_AGENT,
          "Accept-Language": "id,en",
          Cookie: cookie
        }
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new Error(`google-maps/preview responded ${response.status}`);
    }

    const text = await response.text();

    try {
      return parseListing(JSON.parse(text.replace(/^\)\]\}'\n?/, "")));
    } catch {
      throw new Error("google-maps/preview returned an unreadable body");
    }
  };

  let listing = await request();

  // An expired or rejected cookie gets the stub. One refresh, one retry.
  if (looksThin(listing)) {
    cookie = await getWarmCookies({ force: true });
    listing = await request();
  }

  // Still the stub: keep what it has (hours, website) but say so, so the
  // cache does not trust it for days.
  if (looksThin(listing)) {
    listing.thin = true;
  }

  return listing;
}

/**
 * The full listing for a place we know by feature id, from cache when fresh.
 * Returns null when Google has nothing for the id; throws when the request
 * itself failed, so the panel can say which of the two happened.
 */
export async function fetchGoogleMapsListing({ googleId, lat, lng, timeoutMs = 10000 }) {
  const featureId = str(googleId);

  if (!/^0x[0-9a-f]+:0x[0-9a-f]+$/i.test(featureId)) {
    return null;
  }

  const store = getStore();
  const key = `gmaps-listing:${featureId}`;
  let cached = null;

  try {
    cached = store.getGeocode(key);
  } catch (error) {
    console.warn(`[google-maps] listing cache read failed: ${error.message}`);
  }

  if (cached) {
    const age = Date.now() - cached.updatedAt;
    // A miss and a trimmed stub are both retried soon; a full listing lasts.
    const ttl = cached.payload && !cached.payload.thin ? HIT_TTL_MS : MISS_TTL_MS;
    const current = !cached.payload || cached.payload.version === LISTING_VERSION;

    if (age < ttl && current) {
      return cached.payload || null;
    }
  }

  const latitude = Number.isFinite(lat) ? lat : 0;
  const longitude = Number.isFinite(lng) ? lng : 0;
  const listing = await scheduleGoogleRequest(() => fetchListing(featureId, latitude, longitude, timeoutMs));

  try {
    store.saveGeocode(key, listing);
  } catch (error) {
    console.warn(`[google-maps] listing cache write failed: ${error.message}`);
  }

  return listing;
}
