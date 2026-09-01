# Changelog

All notable changes to this project are documented here.

## [2.0.0] — 2026-09-01

Radius-based place discovery, backed by a local place database. The app used to
fail to find places in almost every situation; this release replaces the
discovery layer and the search UI.

### Added

**Place database (`server/lib/db.js`)**

- SQLite-backed place cache using the built-in `node:sqlite` (Node >= 22.5),
  with an automatic JSON-snapshot fallback for runtimes that lack it and an
  in-memory fallback when no disk is writable.
- Tables: `places` (indexed on `lat`/`lng` and `category_id`), `coverage`
  (per tile / per category freshness), `routes` (saved meeting-point locations).
- Seed loading: a committed `data/seed.json` is imported into an empty cache at
  startup, so deployments without a persistent disk still start with real data.

**Discovery engine (`server/lib/discovery.js`)**

- Cache-first search: an already-scraped area is answered from SQLite in
  milliseconds and keeps working while the upstream APIs are unavailable.
- Live fetch on a cold area, under a shared deadline (`createDeadline`), so a
  hung upstream degrades the result instead of failing the request.
- Background top-up after a cold search: Overpass for complete coverage plus the
  long tail of Nominatim tag queries, so the next search in that area is
  instant and richer.
- Per-category coverage recording, so a category whose queries did not complete
  is retried rather than cached as "nothing here".

**Sources**

- `server/lib/sources/nominatim.js` — bounded `viewbox` search using the
  `[key=value]` special-phrase syntax. One shared queue serialises all calls and
  spaces them to honour the 1 request/second usage policy. Adaptive tiling works
  around the hard 50-result cap.
- `server/lib/sources/overpass.js` — per-category queries with mirror rotation
  and demotion of mirrors that just failed. Background use only.

**Category taxonomy (`server/lib/categories.js`)**

- 12 categories (food, cafe, nightlife, shopping, attraction, outdoor,
  entertainment, stay, worship, essential, transport, education) mapped to the
  OSM tags that define them, with a reverse index for labelling raw elements.

**Bulk ingest (`scripts/ingest.js`)**

- `npm run ingest -- --area "Surabaya" --radius 10000` pre-scrapes a city into
  the database. A single 6 km run collects roughly 800 places.
- Flags: `--lat/--lng`, `--categories`, `--budget`, `--export`, `--quiet`.
- `--export data/seed.json` writes a portable seed for disk-less deployments.
- `npm run stats` reports what the database currently holds.

**API**

- `GET /api/places/nearby` — free-form radius (200–30000 m), category filter,
  optional name filter, `refresh` to bypass the cache.
- `GET /api/categories`, `GET /api/reverse`, `GET /api/stats`, `GET /api/health`.
- `DELETE /api/locations` to clear a saved route.
- Unknown `/api/*` paths now return a JSON 404 instead of the SPA shell.

**UI**

- Free radius slider from 200 m to 30 km, replacing three fixed buttons.
- Category filter chips, colour-coded consistently with the map markers.
- Click anywhere on the map to move the search centre; "Search this area" after
  panning; "Use my location" via the browser geolocation API.
- Results list sorted by distance, with walking-time estimates, category
  breakdown chips, and sort-by-name/category.
- Marker hover and selection synchronised between the list and the map.
- Diagnostics surfaced honestly: whether results came from cache, how many
  upstream queries failed, and whether the area is still being filled in.
- Mobile layout: the sidebar becomes a bottom sheet under 720 px.

### Fixed

See `FEATURES.md` for the full list with reproduction details. In summary:

- Location autocomplete returned zero results for every city, district and
  village name.
- The nearby-places Overpass query timed out with HTTP 504 on every request.
- One configured Overpass mirror returned HTTP 200 with an empty result set,
  reporting "no places found" as a success.
- Saved routes were lost between requests on serverless deployments.
- A stale service worker served an outdated app shell after every rebuild,
  producing a blank page with no console error.
- Saved locations were re-geocoded from their display text, discarding the
  coordinates the user had already picked.
- The radius was restricted to exactly 1000, 3000 or 5000 metres.
- Searches were hard-restricted to Indonesian addresses with a misleading error.

### Changed

- Place details are built only from data that exists — real OSM tags, real
  Wikimedia images, and real Google Places fields when a key is configured.
  Unknown values are reported as unknown.
- Sparse places are enriched on demand from the OSM element API (full tag set in
  well under a second) and the result is written back to the cache.
- A place requested by id that is not in the cache is rebuilt from the OSM
  element instead of rendering as "Unnamed place".
- Saved routes are keyed by a per-browser id (`X-Route-Id`), so two browsers no
  longer overwrite each other.
- Partial failures are reported: saving a route returns which inputs did not
  resolve instead of silently dropping them.
- The meeting-point feature is now a way of choosing a search centre, and
  suggests a radius wide enough to reach every saved location.

### Removed

- Fabricated place data. The previous detail panel generated ratings, review
  text, phone numbers, Instagram handles and price ranges from a hash of the
  coordinates, and illustrated every place with the same stock photos. None of
  it was real, and nothing distinguished it from the genuine fields.
  (`buildMockReviews`, `analyzeReviewMix`, `analyzeRealReviews`,
  `buildImageGallery`, `estimatePriceRange`, `hashString`.)
- `client/src/components/LocationInput.vue`, replaced by
  `MeetingPointPanel.vue`.
