# sembarang-budal

A website to find places to go between multiple areas.

## Local development

1. Install dependencies:

```bash
npm install
```

2. Run frontend + backend:

```bash
npm run dev
```

## Deploy to Vercel

1. Push this repository to GitHub.
2. Import the repo in Vercel.
3. Vercel will use `vercel.json` automatically:
   - Build command: `npm run build`
   - Output directory: `dist`
   - API routes served by `api/index.js`
4. Add environment variable in Vercel project settings:
   - `GOOGLE_PLACES_API_KEY` (optional, only for richer photos/reviews)

By default (without API key), this app runs on free/open APIs:
- Nominatim (search and geocoding)
- Overpass (nearby places)

After deployment, Vercel will provide a public URL you can share.
