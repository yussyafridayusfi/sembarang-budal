#!/usr/bin/env node
/**
 * Bulk place ingest.
 *
 * Pre-scrapes an area into the local database so the app answers searches there
 * instantly and keeps working while the free upstream APIs are rate-limiting or
 * down. Run it once per city you care about.
 *
 *   node scripts/ingest.js --area "Surabaya" --radius 10000
 *   node scripts/ingest.js --lat -7.2575 --lng 112.7521 --radius 5000 --categories food,cafe
 *   node scripts/ingest.js --area "Malang" --radius 8000 --export data/seed.json
 *
 * The optional --export writes a portable JSON seed. Deployments with an
 * ephemeral filesystem (Vercel and friends) load that file on cold start, so
 * a deployed instance starts out with real data instead of an empty cache.
 */
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { getStore } from "../server/lib/db.js";
import { boundingBox, splitBoundingBox, tileKeysForBox, boxCenter, haversineDistanceMeters } from "../server/lib/geo.js";
import { createDeadline } from "../server/lib/http.js";
import { CATEGORY_GROUPS, resolveCategoryIds } from "../server/lib/categories.js";
import { fetchOverpassPlaces } from "../server/lib/sources/overpass.js";
import { fetchNominatimPlaces, planTagJobs, searchPlaces } from "../server/lib/sources/nominatim.js";

dotenv.config();

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith("--")) {
      args[key] = "true";
    } else {
      args[key] = next;
      index += 1;
    }
  }

  return args;
}

function usage() {
  console.log(`
Usage:
  node scripts/ingest.js --area "<place name>" [options]
  node scripts/ingest.js --lat <n> --lng <n> [options]

Options:
  --radius <metres>     Area radius. Default 5000.
  --categories <list>   Comma-separated ids, or "all". Default all.
  --export <file>       Also write a portable JSON seed to this path.
  --budget <seconds>    Wall-clock budget. Default 900.
  --quiet               Less output.

Categories: ${CATEGORY_GROUPS.map((group) => group.id).join(", ")}
`);
}

async function resolveCenter(args) {
  const lat = Number(args.lat);
  const lng = Number(args.lng);

  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return { lat, lng, label: `${lat},${lng}` };
  }

  if (!args.area) {
    return null;
  }

  const results = await searchPlaces(args.area, { limit: 5, timeoutMs: 15000 });
  const best = results
    .map((item) => ({ item, lat: Number(item.lat), lng: Number(item.lon) }))
    .filter(({ lat: itemLat, lng: itemLng }) => Number.isFinite(itemLat) && Number.isFinite(itemLng))
    .sort((a, b) => Number(b.item.importance || 0) - Number(a.item.importance || 0))[0];

  if (!best) {
    return null;
  }

  return { lat: best.lat, lng: best.lng, label: best.item.display_name || args.area };
}

/**
 * Nominatim caps every query at 50 results, so a large area has to be split
 * into tiles small enough that no single tile overflows.
 */
function nominatimTiles(box, radius) {
  const divisions = Math.max(1, Math.min(6, Math.round((radius * 2) / 2500)));
  return divisions === 1 ? [box] : splitBoundingBox(box, divisions, divisions);
}

/**
 * Overpass has no result cap and answers a whole radius in one query, so it
 * only needs splitting when the area is large enough to risk a server-side
 * timeout. Handing it the fine Nominatim grid instead just multiplies the
 * number of slow requests by 25.
 */
function overpassTiles(box, radius) {
  if (radius <= 8000) {
    return [box];
  }

  const divisions = radius <= 20000 ? 2 : 3;
  return splitBoundingBox(box, divisions, divisions);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || (!args.area && !(args.lat && args.lng))) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const quiet = args.quiet === "true";
  const log = (...parts) => {
    if (!quiet) {
      console.log(...parts);
    }
  };

  const radius = Math.max(200, Math.min(50000, Number(args.radius) || 5000));
  const categoryIds = resolveCategoryIds(args.categories || "all");
  const budgetMs = Math.max(30, Number(args.budget) || 900) * 1000;

  const center = await resolveCenter(args);

  if (!center) {
    console.error(`Could not resolve an area from "${args.area || ""}". Try a more specific name, or pass --lat/--lng.`);
    process.exit(1);
  }

  const store = getStore();
  const box = boundingBox(center.lat, center.lng, radius);
  const tiles = nominatimTiles(box, radius);
  const coarseTiles = overpassTiles(box, radius);
  const deadline = createDeadline(budgetMs);
  const before = store.stats().places;

  log(`Area      : ${center.label}`);
  log(`Center    : ${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}`);
  log(`Radius    : ${radius} m`);
  log(`Categories: ${categoryIds.join(", ")}`);
  log(`Tiles     : ${coarseTiles.length} for Overpass, ${tiles.length} for Nominatim`);
  log(`Budget    : ${Math.round(budgetMs / 1000)}s`);
  log("");

  let overpassTotal = 0;
  let nominatimTotal = 0;
  const covered = new Set();

  // Overpass first: when it responds it returns every POI in the area, which is
  // far more complete than the capped Nominatim queries.
  for (const [index, tile] of coarseTiles.entries()) {
    if (deadline.expired()) {
      log("Budget exhausted before Overpass finished.");
      break;
    }

    const tileCenter = boxCenter(tile);
    const tileRadius = Math.ceil(
      haversineDistanceMeters(tile.minLat, tile.minLng, tile.maxLat, tile.maxLng) / 2
    );

    const result = await fetchOverpassPlaces({
      lat: tileCenter.lat,
      lng: tileCenter.lng,
      radius: tileRadius,
      categoryIds,
      deadline,
      maxResults: 2000,
      maxPerMirrorMs: 30_000
    });

    if (result.places.length) {
      store.upsertPlaces(result.places);
      overpassTotal += result.places.length;
    }

    (result.coveredCategoryIds || []).forEach((id) => covered.add(id));

    log(
      `overpass  tile ${index + 1}/${coarseTiles.length}: +${result.places.length} places` +
        (result.failures.length ? ` (${result.failures.length} category failures)` : "")
    );
  }

  // Then Nominatim, which fills gaps Overpass missed or could not answer for.
  if (!deadline.expired()) {
    const jobs = planTagJobs(categoryIds, tiles);
    log(`nominatim : ${jobs.length} tag/tile queries queued (~1.1s each)`);

    const result = await fetchNominatimPlaces({ jobs, deadline });

    if (result.places.length) {
      store.upsertPlaces(result.places);
      nominatimTotal += result.places.length;
    }

    (result.coveredCategoryIds || []).forEach((id) => covered.add(id));

    log(
      `nominatim : +${result.places.length} places` +
        (result.pending.length ? `, ${result.pending.length} queries left unrun (budget)` : "") +
        (result.failures.length ? `, ${result.failures.length} failures` : "")
    );
  }

  // Only categories whose queries completed are recorded as covered, so a
  // category that timed out is retried next run instead of caching an
  // incorrect "nothing here".
  if (covered.size) {
    store.markCoverage(tileKeysForBox(box), Array.from(covered));
    log("");
    log(`Covered   : ${Array.from(covered).join(", ")}`);
  }

  const missed = categoryIds.filter((id) => !covered.has(id));

  if (missed.length) {
    log(`Not covered (will be retried): ${missed.join(", ")}`);
  }

  const stats = store.stats();
  log("");
  log(`Stored    : ${stats.places} places total (+${stats.places - before} new)`);
  log(`Backend   : ${stats.backend} at ${stats.location}`);
  log(`By category:`);
  stats.byCategory.forEach((row) => log(`  ${row.categoryId.padEnd(14)} ${row.total}`));

  if (args.export && args.export !== "true") {
    const exportPath = path.resolve(process.cwd(), args.export);
    fs.mkdirSync(path.dirname(exportPath), { recursive: true });

    const places = store.findPlacesInBox(
      { minLat: -90, maxLat: 90, minLng: -180, maxLng: 180 },
      null,
      200000
    );

    fs.writeFileSync(
      exportPath,
      JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), places }, null, 0)
    );

    log("");
    log(`Exported  : ${places.length} places -> ${exportPath}`);
    log("Commit that file to ship this data with a deployment that has no persistent disk.");
  }
}

main().catch((error) => {
  console.error(`Ingest failed: ${error.message}`);
  process.exit(1);
});
