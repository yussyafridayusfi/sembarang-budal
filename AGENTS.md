# AGENTS.md

## Commands

- `npm run dev` — frontend (Vite, :5173) + API (:3000) together
- `npm run build` — Vite build into `dist/`
- `npm start` — Express serving `dist/` + the API on :3000
- `npm run ingest -- --area "<city>" --radius <m>` — pre-scrape places into the DB
- `npm run stats` — what the place database currently holds

There is no test script.

## Layout

- `server/lib/` — the place-discovery engine
  - `db.js` — SQLite cache (`node:sqlite`), with a JSON-snapshot fallback for
    runtimes without it. Also loads `data/seed.json` into an empty store.
  - `discovery.js` — orchestrator: cache first, live fetch on a cold area under
    a shared deadline, background top-up afterwards
  - `sources/photon.js` — the request-path browse source: one request per
    category via `osm_tag=key:value`, run concurrently, with adaptive tiling
    when a response hits Photon's 50-result cap
  - `sources/nominatim.js` — reverse geocoding, the autocomplete fallback and
    the background tag sweep. One shared queue enforces the 1 request/second
    policy, which is why it is no longer on the request path.
  - `sources/overpass.js` — complete but slow and often failing; background only
  - `categories.js` — the category taxonomy, and the OSM tags each maps to
  - `sources/googleMaps.js` — resolves text OSM cannot place through Google
    Maps' embed endpoint; one request per distinct text, cached in `geocodes`
  - `mapLink.js` — resolves a pasted Google Maps / share link to coordinates,
    or to a place name when that is all the link carries
  - `addressQuery.js` — progressively coarser variants of a typed address, so a
    street or house number OSM does not hold degrades to the village instead of
    returning nothing
  - `placeDetails.js` — details from real data only
- `server/routes/` — `places.js` (search, nearby, details) and `locations.js`
  (saved meeting-point locations)
- `client/src/` — Vue 3 SPA; `MapView.vue` (Leaflet), `PlaceSearchPanel.vue`,
  `PlaceResults.vue`, `PlaceDetailModal.vue`, `MeetingPointPanel.vue`

## Things worth knowing before changing the discovery path

- **Browse with Photon, one request per category.** `osm_tag` takes a list of
  `key:value` filters, so a category is one question with its own result slot.
  Asking by bare key (`osm_tag=amenity`) shares one cap across seven categories
  and the dense ones bury the rest.
- **Photon caps every response at 50, silently.** `limit` above that is ignored.
  A response at the cap means there is more you were not shown — subdivide, and
  never record it as covered.
- **`lang=id` fails the whole Photon request.** It supports `default, de, en,
  fr`. Use `default`; it returns local names anyway.
- **Photon is a free public instance and will block you.** Keep concurrency at
  ~4, and respect `LIVE_FETCH_COOLDOWN_MS` — an area whose coverage plateaus
  below the threshold must not re-fetch on every request.
- **Keep Overpass queries small.** One query per category group. A single query
  covering many tags over a 5 km radius returns `504` every time.
- **Do not put Overpass on the request path.** Measured 13 s+ per category
  against the public mirrors.
- **Only use global Overpass mirrors.** `overpass.osm.ch` answers `200` with an
  empty `elements` array, which reads as "no places here".
- **Record coverage per category, and only for categories that completed.**
  Marking a whole request as covered because one category succeeded makes later
  searches for the others answer 0 from cache. The same applies one level down:
  do not mark a category covered having queried only some of its tags.
- **The Google Maps resolver is a last resort, not a search backend.** It runs
  only when OSM found nothing relevant, or the text has a house number, or a
  pasted link yielded only a name. Never call it per keystroke. Read the embed
  payload's *place record* (`["0x…:0x…","<address>",[lat,lng]`), not the first
  coordinate pair in the page - that is the viewport centre, hundreds of metres
  off.
- **Both location boxes accept a raw `lat,lng`.** It is the exact, free way to
  pin a place no geocoder holds. Keep the pattern anchored to the whole input.
- **A `share.google` link has no coordinates in it.** It redirects to Google
  *Search*, and the page served to a non-browser client is a bot check. Only the
  name in `q=` is recoverable, so it must be geocoded and cannot be presented as
  a pinpoint. A `maps.app.goo.gl` / `google.com/maps` link *does* carry them.
- **Photon matches fuzzily, and will answer with the wrong continent.** Asked
  for a name it lacks it returns its nearest fuzzy match anywhere on earth, and
  a lat/lon bias does not suppress it. Run results through `filterByRelevance`
  before showing them.
- **Relax addresses, never names.** Dropping leading tokens finds the village
  behind an unmapped street, and turns "MPM Learning Center" into an unrelated
  "Merpati Maintenance Center". Pass `dropTokens: false` for a proper name.
- **Geocoders are all-or-nothing on free text.** One unplaceable token returns
  zero results, not a coarser match. Relax the query instead of reporting "not
  found" - and say so when you do.
- **Never invent place data.** Missing ratings, photos and phone numbers are
  reported as unknown, not filled in with plausible values.
