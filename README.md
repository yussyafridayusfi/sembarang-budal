# sembarang-budal

Find somewhere to go inside a radius you choose — pick a centre, drag the
radius, filter by category, and get every place in range with distances and
walking times. Runs on free OpenStreetMap services; no API key required.

## How it finds places

Free OSM APIs are unreliable in ways that break a naive implementation:
Overpass regularly answers `504` or `429` and can take 13 s for a single
category, and Nominatim caps every query at 50 results and asks for no more
than one request per second.

So places are **scraped into a local database and served from there**:

1. **Cache first.** A search checks SQLite for places in the bounding box and
   whether the area's tiles are already covered for the requested categories.
   A warm area answers in milliseconds and keeps working while the upstream
   APIs are down.
2. **Live fetch on a cold area.** Bounded Nominatim queries (one per category's
   defining tags) run under a shared deadline, so a hung upstream degrades the
   result instead of failing the request. Whatever comes back is written to the
   database.
3. **Background top-up.** After answering, the server keeps scraping the area —
   Overpass for complete coverage plus the long tail of Nominatim tag queries —
   so the next search there is instant and richer.
4. **Coverage is recorded per category**, and only for categories whose queries
   actually completed. A category that timed out is retried rather than cached
   as "nothing here".

## Local development

```bash
npm install
npm run dev
```

Frontend on `http://localhost:5173`, API on `http://localhost:3000`.

To run the production build from one process:

```bash
npm run build && npm start
```

## Pre-scraping an area

Warm the cache for a city so searches there are instant from the first click:

```bash
npm run ingest -- --area "Surabaya" --radius 10000
```

```bash
npm run ingest -- --lat -7.2575 --lng 112.7521 --radius 5000 --categories food,cafe
```

Useful flags: `--categories all`, `--budget <seconds>`, `--export <file>`,
`--quiet`. `npm run stats` prints what the database holds.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/places/nearby?lat&lng&radius&categories&q&limit&refresh` | Places within `radius` metres (200–30000). `categories` is a comma-separated list or `all`. |
| `GET /api/categories` | The category taxonomy used by the filters. |
| `GET /api/search?query=` | Location autocomplete. |
| `GET /api/reverse?lat&lng` | Label for a coordinate. |
| `GET /api/place/details?id=` | Details for one place, from OSM tags (plus Google Places if a key is set). |
| `GET /api/locations`, `POST`, `DELETE` | Saved meeting-point locations for this browser. |
| `GET /api/stats` | Database contents. |
| `GET /api/health` | Liveness and which storage backend is active. |

## Data honesty

The detail panel shows only data that exists: real OSM tags, real Wikimedia
images, and real Google Places fields when a key is configured. Where a value
is unknown it says so. Ratings, reviews, photos, phone numbers and social links
are never generated.

## Deploying to Vercel

`vercel.json` is already configured (`npm run build` → `dist`, API via
`api/index.js`). Two caveats follow from serverless execution:

- **The filesystem is ephemeral.** The cache lives in `/tmp` and is lost on
  cold start. Run `npm run ingest -- --area "<city>" --export data/seed.json`
  and commit `data/seed.json`; it is loaded into the empty cache at startup.
- **Background top-up is disabled**, because the process is frozen once the
  response is sent. Pre-scrape with the ingest script instead.

Optional environment variables are documented in `.env.example`.
