# Features

Bug fixes that shipped, and what is planned next.

---

## Bug fixes

Each entry records the **type** of defect and the **location** it lived in, so a
similar report can be traced back quickly.

### 1. Autocomplete returned nothing for any city name

| | |
| --- | --- |
| **Type** | Over-restrictive filter — data loss |
| **Location** | `server/routes/locations.js` → `GET /api/search` |
| **Severity** | Critical — the primary cause of "cannot find a place" |

The handler kept only results whose OSM `class` was in an allowlist of
`amenity, tourism, leisure, shop, building, highway, place`. Cities, districts
and villages are all `boundary=administrative`, which is not in that list, so
every one of them was silently discarded.

Reproduced: `q=Surabaya` returns exactly one result, `boundary/administrative`,
which the filter then dropped — leaving **0 suggestions**.

**Fix:** the class filter was removed entirely. Suggestions are now ranked by
Nominatim's own `importance` score and each carries its resolved category, so
the UI can label them without excluding them.
Now in `server/routes/places.js`.

### 2. Nearby-places search timed out on every request

| | |
| --- | --- |
| **Type** | Malformed upstream query — guaranteed timeout |
| **Location** | `server/routes/locations.js` → `handleCenterPlacesRequest` |
| **Severity** | Critical |

A single Overpass query contained 15 sub-statements, including an unbounded
`node["shop"](around:5000,...)` across node, way and relation. Overpass could
never answer it.

Reproduced: **HTTP 504** on every attempt, including against a reduced version
of the query. Split into one query per category group, the same area returns
HTTP 200 with 120–325 elements in 2–7 seconds.

**Fix:** queries are generated per category group in
`server/lib/sources/overpass.js`, and Overpass was moved off the request path
altogether — it measured 13 s+ per category against the public mirrors, so it
would consume the entire budget and contribute nothing.

### 3. An Overpass mirror reported "no places" as success

| | |
| --- | --- |
| **Type** | Silent upstream failure — false negative |
| **Location** | `server/lib/sources/overpass.js` → mirror list |
| **Severity** | High — invisible, and looks like an empty area |

`overpass.osm.ch` is a Switzerland-only instance. Queried for Indonesian
coordinates it answers **HTTP 200 with `elements: []`**, which is
indistinguishable from a legitimate "nothing here" result. Any category routed
to it silently returned zero places and was not recorded as a failure.

**Fix:** the regional mirror was removed, and `runQuery` now rejects any
response whose body has no `elements` array rather than treating it as an empty
success.

### 4. Coverage was claimed for categories that were never queried

| | |
| --- | --- |
| **Type** | Cache poisoning — false negative |
| **Location** | `server/lib/discovery.js` → `discoverPlaces` |
| **Severity** | High |

Introduced while building the cache layer, and caught during verification. An
area was marked as covered for **all** requested categories whenever *any*
category returned data. A category that was never actually reached was then
answered from cache as empty, permanently.

Reproduced: searching 5 categories, then adding "Bar & nightlife", returned
`coverage: 1, liveFetch: false, places: 0` — while Nominatim confirmed **11**
bars, pubs and nightclubs inside that same radius.

**Fix:** both sources now return `coveredCategoryIds`, and coverage is recorded
per category and only for categories whose queries completed. A category that
timed out is retried instead of being cached as empty. A genuine zero is still
cached, which is correct.

### 5. Saved routes disappeared between requests

| | |
| --- | --- |
| **Type** | Invalid state location — data loss on serverless |
| **Location** | `server/store/locations.js` |
| **Severity** | High on deployed environments |

Locations were held in a module-level array. Each serverless invocation runs in
a fresh process, so the `GET /api/locations` that follows a `POST` landed in a
different instance and returned an empty list — the route was gone before the
page finished reloading.

**Fix:** routes are persisted in the database (`routes` table) and keyed by a
per-browser id sent as `X-Route-Id`, so separate browsers no longer overwrite
each other. Verified surviving a `POST` followed by a `GET` in a separate
request.

### 6. A stale service worker served a blank page after every rebuild

| | |
| --- | --- |
| **Type** | Incorrect cache strategy — blank page, no error |
| **Location** | `client/public/sw.js` → `fetch` handler |
| **Severity** | Critical — silent, and affects returning users only |

The worker was cache-first for **everything**, including the navigation request
for `/`. Once `index.html` was cached it was never refetched, so after any new
build the browser was pointed at hashed asset filenames that no longer existed.
The result is a blank page with nothing in the console. `CACHE_NAME` was
hardcoded, so it only invalidated if someone bumped it by hand.

Reproduced mid-session: a rebuild blanked the running app; the stale
`sembarang-budal-v2` cache was holding the previous shell.

**Fix:** the strategy is now split by request type. HTML and other static files
are **network-first with a cached fallback**, because `index.html` names the
hashed assets and must always be fresh. Files under `/assets/` stay
**cache-first**, which is safe since their filenames change with their contents.
A failed precache no longer aborts installation.

### 7. Picked coordinates were thrown away and re-geocoded

| | |
| --- | --- |
| **Type** | Redundant work — wrong-result risk |
| **Location** | `server/routes/locations.js` → `POST /api/locations` |
| **Severity** | Medium |

Saving a route re-geocoded each location's display text from scratch, even
though the user had already picked a specific suggestion. That wasted a
rate-limited geocoding request per location and could resolve to a different
place than the one that was clicked.

**Fix:** the client sends the coordinates of the suggestion it picked and the
server keeps them, falling back to geocoding only for free-typed text. The UI
marks such rows `PINNED`.

### 8. Radius was restricted to three fixed values

| | |
| --- | --- |
| **Type** | Unnecessary constraint |
| **Location** | `server/routes/locations.js` → `ALLOWED_RADII` |
| **Severity** | Medium — blocks the core use case |

Only exactly `1000`, `3000` or `5000` were accepted; anything else was rejected
with HTTP 400.

**Fix:** any radius from 200 m to 30 km is accepted and clamped rather than
rejected. The UI exposes it as a slider.

### 9. Searches were hard-restricted to Indonesia

| | |
| --- | --- |
| **Type** | Hardcoded constraint — misleading error |
| **Location** | `server/routes/locations.js` → `isIndonesianResult`, `geocodeLocation` |
| **Severity** | Medium |

Non-Indonesian results were dropped, and a failed lookup reported
`"Only Indonesian addresses are allowed"` — which was also shown when the place
simply was not found, sending users looking for the wrong problem.

**Fix:** the restriction is now the optional `PLACES_COUNTRY_CODES` environment
variable, empty (worldwide) by default. Failed lookups say what actually went
wrong and suggest adding a city or picking a suggestion.

### 10. A stalled upstream could hang the whole request

| | |
| --- | --- |
| **Type** | Missing timeout — resource exhaustion |
| **Location** | every `fetch` call in `server/routes/locations.js` |
| **Severity** | Medium |

No `fetch` had a timeout, no retry, and no concurrency limit. A single stalled
upstream request burned the entire serverless invocation.

**Fix:** `server/lib/http.js` provides `fetchWithTimeout`, retry limited to
genuinely transient failures (timeout, 429, 5xx), bounded concurrency, and a
shared `createDeadline` so partial results are returned instead of an error.
Overpass's mirror loop recomputes its timeout per mirror — without that, four
mirrors at one timeout each overran the budget several times over.

### 11. Fabricated place data presented as real

| | |
| --- | --- |
| **Type** | Data integrity |
| **Location** | `server/routes/locations.js` → `buildMockReviews`, `analyzeReviewMix`, `buildImageGallery`, `estimatePriceRange` |
| **Severity** | High — actively misleading |

Ratings, review text, phone numbers, Instagram handles and price ranges were
generated from a hash of the coordinates, and every place was illustrated with
the same three stock photos. Nothing distinguished the invented fields from the
genuine ones.

**Fix:** all of it was removed. `server/lib/placeDetails.js` shows real OSM
tags, real Wikimedia images, and real Google Places data when
`GOOGLE_PLACES_API_KEY` is set. Unknown values are reported as unknown, and each
panel lists the sources it drew from.

---

## Next features

### 1. Better UI

The current sidebar is functional but dense, and the map is doing most of the
work. Planned, roughly in order of value:

**Layout and hierarchy**
- Collapsible sidebar so the map can be used full-width; a floating search bar
  over the map in the collapsed state.
- Move the category filters into a horizontal scrolling strip pinned above the
  results, closer to how a maps app presents them.
- Sticky results header, so the count and sort control stay visible while
  scrolling a long list.
- Virtualised results list — 300 rows are rendered eagerly today, which is
  noticeable on a mid-range phone.

**Map interaction**
- Marker clustering at low zoom. Several hundred markers within a 30 km radius
  currently overlap into an unreadable mass.
- A compact result card on marker tap, with the full panel one tap further, so
  a quick look does not cover the map.
- Draw the radius by dragging a handle on the circle itself, in addition to the
  slider.
- Show the selected place's walking route, not just its straight-line distance.

**Detail panel**
- Present it as a bottom sheet on mobile rather than a centred modal.
- Show opening hours as "open now / closes at" rather than a raw OSM
  `opening_hours` string.
- Keyboard handling: `Esc` to close, focus trapping, restore focus on close.

**Polish**
- Skeleton placeholders during the 6–14 s cold search, instead of only a
  "Searching…" label.
- Dark mode, following `prefers-color-scheme`.
- Save recent searches and let a centre be bookmarked.
- Shareable URLs that encode centre, radius and categories, so a search can be
  sent to the people you are meeting.

### 2. Use the device's current location

A basic version already works: "Use my location" calls
`navigator.geolocation.getCurrentPosition` and sets the search centre, with
distinct messages for a denied permission and a failed lookup. What is planned
goes beyond that first fix:

- **Offer it on first load.** Right now the app opens with no centre and waits.
  It should ask once whether to start from where you are, and remember the
  answer.
- **Show the accuracy radius.** A GPS fix can be hundreds of metres out
  indoors; drawing the reported accuracy makes an odd-looking result
  explicable.
- **Live tracking mode.** `watchPosition` with a follow-me toggle, so distances
  and walking times update as you move.
- **A device-location marker distinct from the search centre**, with a
  "recentre on me" control, so you can browse elsewhere without losing your own
  position.
- **Sensible fallbacks.** Fall back to a coarse IP-based location when
  geolocation is denied or unavailable, clearly labelled as approximate, and
  cache the last known position so a reload does not start from nothing.
- **Handle the insecure-origin case.** `geolocation` requires HTTPS (except on
  `localhost`); the current failure message does not say so.
- **"Places near me" as a first-class action**, distinct from picking a centre
  on the map — one tap from opening the app to a list of what is around you.
