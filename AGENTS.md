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
  - `sources/nominatim.js` — bounded `viewbox` search using the `[key=value]`
    special-phrase syntax; the primary source. One shared queue enforces the
    1 request/second policy.
  - `sources/overpass.js` — complete but slow and often failing; background only
  - `categories.js` — the category taxonomy, and the OSM tags each maps to
  - `placeDetails.js` — details from real data only
- `server/routes/` — `places.js` (search, nearby, details) and `locations.js`
  (saved meeting-point locations)
- `client/src/` — Vue 3 SPA; `MapView.vue` (Leaflet), `PlaceSearchPanel.vue`,
  `PlaceResults.vue`, `PlaceDetailModal.vue`, `MeetingPointPanel.vue`

## Things worth knowing before changing the discovery path

- **Keep Overpass queries small.** One query per category group. A single query
  covering many tags over a 5 km radius returns `504` every time.
- **Do not put Overpass on the request path.** Measured 13 s+ per category
  against the public mirrors.
- **Only use global Overpass mirrors.** `overpass.osm.ch` answers `200` with an
  empty `elements` array, which reads as "no places here".
- **Record coverage per category, and only for categories that completed.**
  Marking a whole request as covered because one category succeeded makes later
  searches for the others answer 0 from cache.
- **Never invent place data.** Missing ratings, photos and phone numbers are
  reported as unknown, not filled in with plausible values.
