import fs from "fs";
import path from "path";
import { createRequire } from "module";

const requireFromHere = createRequire(import.meta.url);

/**
 * Persistent place cache.
 *
 * Every place we ever fetch from an upstream OSM service is written here, so a
 * repeat search is answered locally in milliseconds and - critically - still
 * works while Overpass/Nominatim are rate-limiting or down, which is the normal
 * state of affairs for the free tiers.
 *
 * SQLite is used when the runtime provides `node:sqlite` (Node >= 22.5).
 * Otherwise we fall back to an in-process store that snapshots to a JSON file,
 * which keeps the app functional on older runtimes with no native deps.
 */

const IS_SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

function resolveDataDir() {
  if (process.env.PLACES_DATA_DIR) {
    return process.env.PLACES_DATA_DIR;
  }

  // Serverless filesystems are read-only apart from /tmp. The cache is
  // ephemeral there but still shared across warm invocations.
  return IS_SERVERLESS ? "/tmp/sembarang-budal" : path.resolve(process.cwd(), "data");
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (error) {
    console.warn(`[db] cannot create data dir ${dir}: ${error.message}`);
    return false;
  }
}

function placeRowToObject(row) {
  let tags = {};

  try {
    tags = row.tags_json ? JSON.parse(row.tags_json) : {};
  } catch {
    tags = {};
  }

  return {
    id: row.id,
    osmType: row.osm_type,
    osmId: row.osm_id,
    name: row.name,
    lat: row.lat,
    lng: row.lng,
    categoryId: row.category_id,
    tagKey: row.tag_key,
    tagValue: row.tag_value,
    type: row.tag_value,
    address: row.address || "",
    source: row.source || "osm",
    tags,
    updatedAt: row.updated_at
  };
}

function createSqliteStore(DatabaseSync, filePath) {
  const db = new DatabaseSync(filePath);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS places (
      id TEXT PRIMARY KEY,
      osm_type TEXT,
      osm_id TEXT,
      name TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      category_id TEXT NOT NULL,
      tag_key TEXT,
      tag_value TEXT,
      tags_json TEXT,
      address TEXT,
      source TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS places_lat_lng ON places (lat, lng);
    CREATE INDEX IF NOT EXISTS places_category ON places (category_id);

    CREATE TABLE IF NOT EXISTS coverage (
      tile_key TEXT NOT NULL,
      category_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tile_key, category_id)
    );

    CREATE TABLE IF NOT EXISTS routes (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const upsertPlaceStatement = db.prepare(`
    INSERT INTO places (
      id, osm_type, osm_id, name, lat, lng, category_id,
      tag_key, tag_value, tags_json, address, source, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      lat = excluded.lat,
      lng = excluded.lng,
      category_id = excluded.category_id,
      tag_key = excluded.tag_key,
      tag_value = excluded.tag_value,
      tags_json = excluded.tags_json,
      address = CASE
        WHEN excluded.address IS NOT NULL AND excluded.address != '' THEN excluded.address
        ELSE places.address
      END,
      source = excluded.source,
      updated_at = excluded.updated_at
  `);

  const markCoverageStatement = db.prepare(`
    INSERT INTO coverage (tile_key, category_id, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(tile_key, category_id) DO UPDATE SET updated_at = excluded.updated_at
  `);

  const selectPlaceStatement = db.prepare("SELECT * FROM places WHERE id = ?");
  const selectRouteStatement = db.prepare("SELECT payload_json FROM routes WHERE id = ?");
  const upsertRouteStatement = db.prepare(`
    INSERT INTO routes (id, payload_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at
  `);

  return {
    kind: "sqlite",
    location: filePath,

    upsertPlaces(places) {
      if (!places.length) {
        return 0;
      }

      const now = Date.now();
      db.exec("BEGIN");

      try {
        places.forEach((place) => {
          upsertPlaceStatement.run(
            place.id,
            place.osmType || null,
            place.osmId != null ? String(place.osmId) : null,
            place.name,
            place.lat,
            place.lng,
            place.categoryId,
            place.tagKey || null,
            place.tagValue || null,
            JSON.stringify(place.tags || {}),
            place.address || "",
            place.source || "osm",
            now
          );
        });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      return places.length;
    },

    getPlaceById(id) {
      const row = selectPlaceStatement.get(id);
      return row ? placeRowToObject(row) : null;
    },

    findPlacesInBox(box, categoryIds, limit = 500) {
      const params = [box.minLat, box.maxLat, box.minLng, box.maxLng];
      let sql =
        "SELECT * FROM places WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?";

      if (categoryIds && categoryIds.length) {
        sql += ` AND category_id IN (${categoryIds.map(() => "?").join(",")})`;
        params.push(...categoryIds);
      }

      sql += " LIMIT ?";
      params.push(limit);

      return db.prepare(sql).all(...params).map(placeRowToObject);
    },

    markCoverage(tileKeys, categoryIds) {
      const now = Date.now();
      db.exec("BEGIN");

      try {
        tileKeys.forEach((tileKey) => {
          categoryIds.forEach((categoryId) => {
            markCoverageStatement.run(tileKey, categoryId, now);
          });
        });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    coverageRatio(tileKeys, categoryIds, maxAgeMs) {
      if (!tileKeys.length || !categoryIds.length) {
        return 0;
      }

      const threshold = Date.now() - maxAgeMs;
      const placeholders = tileKeys.map(() => "?").join(",");
      const categoryPlaceholders = categoryIds.map(() => "?").join(",");
      const row = db
        .prepare(
          `SELECT COUNT(*) AS fresh FROM coverage
           WHERE tile_key IN (${placeholders})
             AND category_id IN (${categoryPlaceholders})
             AND updated_at >= ?`
        )
        .get(...tileKeys, ...categoryIds, threshold);

      return Number(row?.fresh || 0) / (tileKeys.length * categoryIds.length);
    },

    saveRoute(id, payload) {
      upsertRouteStatement.run(id, JSON.stringify(payload), Date.now());
    },

    getRoute(id) {
      const row = selectRouteStatement.get(id);

      if (!row) {
        return null;
      }

      try {
        return JSON.parse(row.payload_json);
      } catch {
        return null;
      }
    },

    stats() {
      const places = db.prepare("SELECT COUNT(*) AS total FROM places").get();
      const tiles = db.prepare("SELECT COUNT(*) AS total FROM coverage").get();
      const byCategory = db
        .prepare("SELECT category_id, COUNT(*) AS total FROM places GROUP BY category_id ORDER BY total DESC")
        .all();

      return {
        backend: "sqlite",
        location: filePath,
        places: Number(places?.total || 0),
        coverageTiles: Number(tiles?.total || 0),
        byCategory: byCategory.map((row) => ({ categoryId: row.category_id, total: Number(row.total) }))
      };
    }
  };
}

function createMemoryStore(snapshotPath) {
  const places = new Map();
  const coverage = new Map();
  const routes = new Map();
  let snapshotTimer = null;

  if (snapshotPath && fs.existsSync(snapshotPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
      (raw.places || []).forEach((place) => places.set(place.id, place));
      Object.entries(raw.coverage || {}).forEach(([key, value]) => coverage.set(key, value));
      Object.entries(raw.routes || {}).forEach(([key, value]) => routes.set(key, value));
    } catch (error) {
      console.warn(`[db] cannot read snapshot: ${error.message}`);
    }
  }

  function scheduleSnapshot() {
    if (!snapshotPath || snapshotTimer) {
      return;
    }

    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;

      try {
        fs.writeFileSync(
          snapshotPath,
          JSON.stringify({
            places: Array.from(places.values()),
            coverage: Object.fromEntries(coverage),
            routes: Object.fromEntries(routes)
          })
        );
      } catch (error) {
        console.warn(`[db] cannot write snapshot: ${error.message}`);
      }
    }, 2000);

    if (typeof snapshotTimer.unref === "function") {
      snapshotTimer.unref();
    }
  }

  return {
    kind: "memory",
    location: snapshotPath || "(in-memory only)",

    upsertPlaces(incoming) {
      const now = Date.now();

      incoming.forEach((place) => {
        const existing = places.get(place.id);
        places.set(place.id, {
          ...existing,
          ...place,
          address: place.address || existing?.address || "",
          updatedAt: now
        });
      });

      scheduleSnapshot();
      return incoming.length;
    },

    getPlaceById(id) {
      const place = places.get(id);
      return place ? { ...place } : null;
    },

    findPlacesInBox(box, categoryIds, limit = 500) {
      const allowed = categoryIds && categoryIds.length ? new Set(categoryIds) : null;
      const found = [];

      for (const place of places.values()) {
        if (found.length >= limit) {
          break;
        }

        if (place.lat < box.minLat || place.lat > box.maxLat) {
          continue;
        }

        if (place.lng < box.minLng || place.lng > box.maxLng) {
          continue;
        }

        if (allowed && !allowed.has(place.categoryId)) {
          continue;
        }

        found.push({ ...place });
      }

      return found;
    },

    markCoverage(tileKeys, categoryIds) {
      const now = Date.now();

      tileKeys.forEach((tileKey) => {
        categoryIds.forEach((categoryId) => {
          coverage.set(`${tileKey}|${categoryId}`, now);
        });
      });

      scheduleSnapshot();
    },

    coverageRatio(tileKeys, categoryIds, maxAgeMs) {
      if (!tileKeys.length || !categoryIds.length) {
        return 0;
      }

      const threshold = Date.now() - maxAgeMs;
      let fresh = 0;

      tileKeys.forEach((tileKey) => {
        categoryIds.forEach((categoryId) => {
          if ((coverage.get(`${tileKey}|${categoryId}`) || 0) >= threshold) {
            fresh += 1;
          }
        });
      });

      return fresh / (tileKeys.length * categoryIds.length);
    },

    saveRoute(id, payload) {
      routes.set(id, payload);
      scheduleSnapshot();
    },

    getRoute(id) {
      return routes.get(id) || null;
    },

    stats() {
      const byCategory = new Map();

      for (const place of places.values()) {
        byCategory.set(place.categoryId, (byCategory.get(place.categoryId) || 0) + 1);
      }

      return {
        backend: "memory",
        location: snapshotPath || "(in-memory only)",
        places: places.size,
        coverageTiles: coverage.size,
        byCategory: Array.from(byCategory, ([categoryId, total]) => ({ categoryId, total })).sort(
          (a, b) => b.total - a.total
        )
      };
    }
  };
}

function createStore() {
  const dataDir = resolveDataDir();
  const writable = ensureDir(dataDir);

  if (writable) {
    try {
      // Resolved lazily so runtimes without node:sqlite fall through to the
      // JSON snapshot store instead of failing at import time.
      const { DatabaseSync } = requireFromHere("node:sqlite");
      const store = createSqliteStore(DatabaseSync, path.join(dataDir, "places.db"));
      console.log(`[db] sqlite store ready at ${store.location}`);
      return store;
    } catch (error) {
      console.warn(`[db] sqlite unavailable (${error.message}); using JSON snapshot store`);
    }
  }

  const snapshotPath = writable ? path.join(dataDir, "places.json") : null;
  const store = createMemoryStore(snapshotPath);
  console.log(`[db] memory store ready (${store.location})`);
  return store;
}

/**
 * Load a committed seed file into an empty store.
 *
 * Deployments without a persistent disk (Vercel and friends) start with an
 * empty cache on every cold start. `npm run ingest -- --export data/seed.json`
 * produces this file; committing it means a deployed instance answers searches
 * for the seeded areas immediately instead of depending on the free upstream
 * APIs being healthy at that moment.
 */
function loadSeed(store) {
  const seedPath = process.env.SEED_FILE || path.resolve(process.cwd(), "data/seed.json");

  if (!fs.existsSync(seedPath)) {
    return;
  }

  if (store.stats().places > 0) {
    return;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(seedPath, "utf8"));
    const places = Array.isArray(raw.places) ? raw.places : [];

    if (!places.length) {
      return;
    }

    store.upsertPlaces(places);

    // Seeded areas are trusted as covered so they are served from disk.
    const tiles = new Set();
    const categories = new Set();

    places.forEach((place) => {
      tiles.add(tileKeyFor(place.lat, place.lng));
      categories.add(place.categoryId);
    });

    store.markCoverage(Array.from(tiles), Array.from(categories));
    console.log(`[db] seeded ${places.length} places from ${seedPath}`);
  } catch (error) {
    console.warn(`[db] could not load seed ${seedPath}: ${error.message}`);
  }
}

/** Kept in sync with the tile size in geo.js. */
function tileKeyFor(lat, lng) {
  return `${Math.floor(lat / 0.01)}:${Math.floor(lng / 0.01)}`;
}

let cached = null;

export function getStore() {
  if (!cached) {
    cached = createStore();
    loadSeed(cached);
  }

  return cached;
}
