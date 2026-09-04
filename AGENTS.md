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
  - `placeDetails.js` — details from real data only: OSM tags, the Google Maps
    card, Google Places API (keyed), and counted review findings; every field
    carries its source and `null` means unknown
  - `googlePlacesApi.js` — Places API (New) adapter, keyed and optional; photos
    are served through `/api/place/photo` so the key never reaches the browser
  - `reviewInsights.js` — pros, cons, complaints, best menu, waiting time,
    crowd, parking, payment, findability, *counted* from review texts with
    "N of M reviews" on every finding; nothing is inferred without a mention
- `server/routes/` — `places.js` (search, nearby, details) and `locations.js`
  (saved meeting-point locations)
- `client/src/` — Vue 3 SPA; `MapView.vue` (Leaflet + markercluster, draggable
  centre and radius handle, popup cards), `PlaceSearchPanel.vue` (search,
  summary bar, chip strip), `PlaceResults.vue`, `PlaceDetailModal.vue` (bottom
  sheet on phones), `MeetingPointPanel.vue`; `lib/categories.js` is the single
  source for a category's colour, glyph and labels. `App.vue` keeps the search
  in the URL hash and recent centres in `localStorage`.
- `nodemon.json` — dev API runs on `API_PORT=3000` and watches only `server/`;
  `PORT` alone is honoured in production. Tools that export `PORT` for the Vite
  dev server would otherwise hand it to Express and serve the stale `dist/`.

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
- **The Google Maps embed card carries more than coordinates.** Rating, review
  count, phone, website, category, weekly hours, open-now and the Place ID are
  all in the ~3 KB payload. Photos, price, review text and attributes are not -
  those are Places API only. Only attach a card to an OSM place when it lands
  within 300 m *and* shares the name; a wrong card with a real source label is
  bug 11 again.
- **The embed place record closes with a CID string.** `["0x…","addr",[lat,lng],
  "6838982894568862351"]` - anchor on `(?:,"\d+")?\],` before reading the
  display name and address lines, or category and lines silently come back
  empty. Read a closed day's hours as a balanced bracket segment, not a regex;
  `null` there bled "Minggu Tutup, Senin, 08.00–17.00" out of one day.
- **Build the card hint from address parts that are not the name or a house
  number, and cascade.** An OSM address of "Royal Plaza, 16-18, Jalan…" made
  the query "Royal Plaza Royal Plaza 16-18", which Google could not place, and
  the miss was cached for a day. `fetchGoogleMapsCard` now tries hinted → city
  → bare name; the 300 m distance guard is what decides, the hint only steers.
- **Never call the Google Maps resolver on a typing fragment.** "ro", "royal
  pla", "royal plaa" each reached Google and were cached as misses. The `/search`
  fallback requires a finished-looking query: two identifying tokens with the
  last at least four letters, or a house number.
- **Test details with `point/…` ids, never a made-up `node/N`.** `node/1` is a
  real node in Italy and `node/999999999` is in Minnesota; the details route
  trusts the OSM id over the client's coordinates, so a fake id silently moves
  the place and the 300 m card guard then - correctly - rejects the card.
- **Never label an unnamed POI by its street.** Nominatim falls back to the
  first part of `display_name`; that made cafes called "Jalan Garuda". Drop
  unnamed POIs at the source (as Overpass and Photon do) and treat a
  street-like name as `unnamed` in details - never look it up by name.
- **Do not write regexes through a bash heredoc into Python.** The heredoc
  passes `` as a single backslash, Python turns it into a backspace byte, and
  the regex then matches nothing while looking fine in an editor. Use the Edit
  tool or a node string replacement for anything with a backslash.
- **Review findings are counts, not facts.** "Parking: difficult" must always
  read "2 of 5 reviews". Five API review texts never speak for ten thousand
  ratings; keep `basedOn` and `reviewCount` apart in the UI.
- **Never invent place data.** Missing ratings, photos and phone numbers are
  reported as unknown, not filled in with plausible values.
