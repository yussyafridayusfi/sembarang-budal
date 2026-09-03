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

### 12. Most categories returned nothing, whatever the location

| | |
| --- | --- |
| **Type** | Upstream throughput exhausted — false negative |
| **Location** | `server/lib/discovery.js` → `discoverPlaces`, `server/lib/sources/nominatim.js` |
| **Severity** | Critical — the reported "not every place is covered" |

The request path browsed with Nominatim's `[key=value]` special-phrase search,
which needs **one request per tag value** — 40+ for the full taxonomy. Its usage
policy allows one request per second, so every one of them was serialised behind
a shared queue: roughly 45 s of requests against a 14 s budget. Whatever did not
fit returned nothing, and "nothing" is indistinguishable from "there is nothing
there".

Reproduced at Gedangan, Sidoarjo (`-7.3894, 112.7277`, 3 km, all categories):
**73 places, 12 of 24 jobs run, 1 of 12 categories covered.** Nightlife,
entertainment, transport, attractions and outdoors were all empty.

**Fix:** Photon (`server/lib/sources/photon.js`) is the request-path browse
source. It takes a list of `osm_tag=key:value` filters, so a category is **one**
request, and it answers them concurrently. Same search: **143 places, 10 of 12
categories covered.** Nominatim keeps reverse geocoding and the fallbacks.

Two things that are not obvious about Photon:

- `lang=id` is **rejected** — it supports `default, de, en, fr` only, and the
  whole request fails. `default` is what we want anyway: it returns local names.
- `limit` is capped at **50** whatever you ask for, and a capped response is
  silent. See bug 13.

### 13. A category was recorded as covered after two of its tags were queried

| | |
| --- | --- |
| **Type** | Cache poisoning — false negative |
| **Location** | `server/lib/discovery.js` → `FOREGROUND_TAGS_PER_CATEGORY` |
| **Severity** | High — permanent, and silent |

Bug 4 fixed coverage being recorded per *request*; this is the same defect one
level down. The request path queried only the first two tag values of each
category (`FOREGROUND_TAGS_PER_CATEGORY = 2`) but then marked the **whole
category** covered. "Shopping" was recorded as complete having asked only about
`shop=mall` and `shop=department_store` — so every supermarket, minimarket and
convenience store in the area was cached as not existing, and in Indonesia that
is most of the shops.

**Fix:** a category is covered only when every one of its tags completed *and*
the response came back under Photon's 50-result cap. A capped response means
"there is more here than you were shown", so it is never treated as complete —
the area is subdivided into quarters and asked again, adaptively, so only the
dense categories pay for the extra requests.

### 14. An area that could not reach full coverage re-fetched forever

| | |
| --- | --- |
| **Type** | Unbounded retry — upstream abuse |
| **Location** | `server/lib/discovery.js` → `needsLiveFetch` |
| **Severity** | High — got the app blocked by the upstream |

A live fetch ran whenever coverage was below 0.85. Coverage does not always get
there: one category that genuinely caps everywhere leaves it at 0.83 forever. So
every single request re-ran a dozen upstream calls to rebuild results it already
had cached and that had not changed.

Reproduced, and it is not theoretical: three searches of the same area in a row
went `14 of 18 jobs → 2 of 12 → 0 of 12` as the mirror throttled us, then
`photon.komoot.io` refused connections outright — a connection-level block from
a few minutes of this.

**Fix:** `LIVE_FETCH_COOLDOWN_MS` (10 minutes) rests an area after a live fetch;
inside that window a search with cached results is served from cache. Repeat
searches went from 14 s of upstream traffic to **~300 ms from cache**. Photon
concurrency is held at 4 — eight drew HTTP 503s.

### 15. No upstream, no results, no explanation

| | |
| --- | --- |
| **Type** | Missing fallback and missing empty state |
| **Location** | `server/routes/places.js` → `GET /api/search`, `client/src/components/PlaceSearchPanel.vue` |
| **Severity** | High — this is what "typing gedangan shows nothing" looks like |

Two independent halves of the same symptom.

On the server, autocomplete and place search each had exactly one source. When
it was unavailable the endpoint returned a 502 or an empty list.

On the client, `scheduleSuggest` rendered the dropdown only when
`suggestions.length || searching`. A lookup that failed or legitimately matched
nothing therefore drew **no dropdown at all** — identical to the app ignoring
the keystroke. The `finally` also cleared the spinner on an aborted request, so
a superseded keystroke blanked the list belonging to the newer one.

**Fix:** `/api/search` tries Photon, then falls back to Nominatim; place search
falls back to Nominatim when Photon returns nothing *and* reported failures.
Verified with Photon fully blocked: `query=gedangan` still returns **12
suggestions**, and the 3 km search still returns real places instead of an empty
list. The client now shows the failure message, or "No places match …", and an
aborted request no longer clears the newer request's spinner.

### 16. A full street address matched nothing at all

| | |
| --- | --- |
| **Type** | All-or-nothing upstream query — false negative |
| **Location** | `server/routes/places.js` → `GET /api/search` |
| **Severity** | High — the way people actually type an address |

Reported as: typing `jl tumapel no 34 ketajen gedangan` shows nothing.

Both geocoders are effectively all-or-nothing on free text. One token they
cannot place takes the result count to zero rather than degrading to a coarser
match, and an Indonesian address is written specific-to-general, so the tokens
most likely to fail come first. Measured against Nominatim:

| query | results |
| --- | --- |
| `jl tumapel no 34 ketajen gedangan` | 0 |
| `jalan tumapel ketajen gedangan` | 0 |
| `tumapel ketajen gedangan` | 0 |
| `ketajen gedangan` | **1** — Ketajen, Gedangan, Sidoarjo |

So Jalan Tumapel is simply not in OSM here, and no amount of querying will
conjure it. But the village two tokens later *is*, and answering with it beats
answering with nothing.

**Fix:** `server/lib/addressQuery.js` builds progressively coarser variants of
the query — expand Indonesian abbreviations (`jl`/`jln` → `jalan`), drop what
OSM does not hold at street level (`no 34`, `RT 03/RW 05`, postcodes), then drop
leading tokens down to a floor of two. `/api/search` tries them in order and
stops at the first that answers, so a query that already works still costs
exactly one request.

The response carries `matchedQuery` when the query had to be relaxed, and the
UI shows *"No exact match. Showing results for …"* — a street the map does not
have must not be presented as though it were found.

Verified:

| typed | answered with |
| --- | --- |
| `jl tumapel no 34 ketajen gedangan` | Ketajen, Gedangan, Sidoarjo |
| `Jl. Raya Darmo No. 68, Surabaya` | Jalan Raya Darmo, Tegalsari, Surabaya |
| `Perum Puri Surya Jaya Blok F2 RT 03/RW 05 Gedangan Sidoarjo` | Puri Surya Jaya, Gedangan |
| `gedangan` | exact, 12 suggestions, no relaxation |

**Known trade-off:** relaxation can reach a long way for input that matches
nothing anywhere — `zzzqqq nowhere place` relaxes to `nowhere place` and finds
one in Arizona. It is labelled as a relaxed match, and setting
`PLACES_COUNTRY_CODES=id` confines it for an Indonesia-only deployment.

---

## Features

### Paste a Google Maps or Google share link as a location

Anywhere a location is typed — the search centre and every meeting-point row —
a pasted Google link is resolved instead of being sent to a geocoder as literal
text. `server/lib/mapLink.js` does the reading, `GET /api/search` the wiring, so
both panels got it from one change.

How well it works depends on which kind of link it is, and that is not a detail
we can paper over:

**A Maps link carries the position.** `maps.app.goo.gl/…`, or a full
`google.com/maps/place/…` URL, has the coordinates in the URL itself. Following
the redirect and parsing it is exact and needs no lookup. `!3d<lat>!4d<lng>` is
preferred over `@<lat>,<lng>` — the first is the pin, the second is only where
the map viewport happened to be, which drifts at low zoom. `ll`, `center`,
`daddr`, `destination` and `q=<lat>,<lng>` are read too.

**A Google *Search* share link does not.** Both links this was reported with —
`share.google/MDMjq1aiXLDDhbPv2` and `share.google/TQWod1tXOKra2IdyS` — redirect
to `google.com/search?q=…`, and the page Google serves a non-browser client is a
bot-check notice: no address, no coordinates, nothing. Verified by scanning the
whole 91 KB body for coordinate patterns, `/maps/` URLs and any of "Jalan",
"Sidoarjo", "Surabaya", "Jawa Timur". The only thing recoverable is the place
*name* from the query string, which then has to be geocoded like any other text.

That has two consequences, both surfaced in the UI rather than hidden:

- **A bare name is ambiguous.** `share.google/TQWod1tXOKra2IdyS` yields only
  "Royal Plaza", which geocodes to Lima, Peru. So `/api/search` takes an
  optional `near=lat,lng` bias, and the client sends the best anchor it has —
  another already-pinned meeting-point row, else the current map centre. With
  Ketajen pinned, the same link resolves to **Royal Plaza, Jalan Jenderal
  Achmad Yani, Wonokromo, Surabaya**, as the only result.
- **The place may not be in OSM at all.** `share.google/MDMjq1aiXLDDhbPv2`
  yields "MPM Learning Center - Sidoarjo", which OpenStreetMap does not have.
  The row says so and points at the Maps app, rather than offering a wrong pin.

**Why a `share.google` link can never be exact.** Its final URL carries exactly
two useful things: `q=MPM Learning Center - Sidoarjo` and
`kgmid=/g/11b8v9fx2_`, a Knowledge Graph id. No coordinates. Nor does the page
behind it — that is the bot-check notice, and it has none either. So scraping
buys nothing here: there is no position on the page to extract, only an
anti-bot arms race and a Google ToS violation. The position lives behind
Google's APIs, or in a Maps link, or in a coordinate you copy yourself.

Set `GOOGLE_PLACES_API_KEY` and a name off a share link is resolved through
Google Places Text Search first — a Google link names a Google place, so Google
will find it even when OSM cannot. Entirely optional; without a key the OSM path
stands.

**One bug this surfaced.** Query relaxation (bug 16) drops leading tokens, which
is right for an address and wrong for a proper name: "MPM Learning Center -
Sidoarjo" relaxed to "Center - Sidoarjo" and confidently returned an unrelated
"Merpati Maintenance Center". Link-derived names now normalise but never
truncate (`buildQueryVariants(name, { dropTokens: false })`).

**And a second.** With Photon unreachable, a name that genuinely does not exist
was reported as *"Address lookup is unavailable right now"* — because a failed
primary source outranked a successful secondary one that simply found nothing.
`firstMatch` now tracks whether a source *answered* separately from whether it
found anything, so an outage and an empty result are no longer the same thing.

**And a third: a fuzzy source answering with something else entirely.** Asked
for a name it does not hold, Photon returns its nearest fuzzy match anywhere on
earth. "MPM Learning Center - Sidoarjo" was answered with **Smart Start Learning
Center in Nukus, Uzbekistan**, then Lae in Papua New Guinea, then Bhopal — each
matching on "learning center" alone, none containing "MPM" or "Sidoarjo", and a
`lat`/`lon` bias towards Sidoarjo did not change them. Offering those as
candidates is worse than returning nothing: the user is invited to pin a place
9,000 km from where they meant.

`filterByRelevance` in `server/lib/addressQuery.js` now drops any result sharing
no *distinctive* token with the query — distinctive meaning "not a generic place
word", so "MPM" and "Sidoarjo" count while "learning" and "center" do not. It is
matched against name and address together, so a place named for its street still
passes, and a fully generic query is left unfiltered rather than filtered
arbitrarily.

With nothing left to show, the trailing area of the link name is used instead:
"MPM Learning Center - **Sidoarjo**". The row reads *"MPM Learning Center -
Sidoarjo is not on the map — showing Sidoarjo, the area named in the link. Drop
a pin on the map if you need the exact spot."* For picking a meeting point that
is genuinely useful, and it never pretends to be the place itself.

Results are also ordered by distance whenever a bias point exists, so "Royal
Plaza" near Surabaya lists Surabaya first rather than in Photon's own order.

**The exact escape hatch: paste the coordinates.** Right-click a spot in Google
Maps and the first menu item copies `-7.3775, 112.7364`. Both location boxes now
accept that directly — no API key, no lookup, no ambiguity, and it is the only
free way to pin a place that exists in Google's index but not in OSM's. The
pattern is anchored to the whole input on purpose: matching a pair *inside* a
longer string would take the "16 18" out of "Jalan Achmad Yani 16-18" and drop a
pin off the coast of Africa. Two bare integers are rejected too — far more
likely a house number than a position.

**A limitation that remains, and cannot be fixed here:** MPM Learning Center is
not in OpenStreetMap at all. Nominatim returns zero for every spelling of it.
Searching its address instead — `Jl. Raya Sedati No.101, Wedi, Kec. Gedangan,
Sidoarjo`, from the Google panel — lands within about a kilometre. For an exact
pin, share from the Maps app or set `GOOGLE_PLACES_API_KEY`.

**And a fourth, in the CSS.** `.combo-list strong` was `display: block`, which is
right for a suggestion row — the place name sits above its address — but it also
caught inline emphasis inside a status message, breaking a sentence across three
lines mid-clause ("Share from the Google" / "**Maps**" / "app instead…"). The
rule is now scoped to `.combo-list button strong`, and the notices are built as
an explicit title line plus a body line rather than relying on inline markup.

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
