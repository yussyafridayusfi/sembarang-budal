#!/usr/bin/env node
/**
 * Import Overture Maps places into the place cache.
 *
 *   python -m pip install overturemaps
 *   python -m overturemaps download --bbox=112.60,-7.45,112.85,-7.20 \
 *       -f geojsonseq --type=place -o data/overture-places.geojsonseq
 *   node scripts/import-overture.js data/overture-places.geojsonseq --export data/seed.json
 *
 * Overture's places theme (ODbL-compatible, CDLA-Permissive 2.0) carries what
 * OSM often lacks for small Indonesian businesses - a category, a website,
 * Instagram and Facebook pages, a phone - and it holds many shops OSM has never
 * had. Its categories are Overture's own taxonomy ("automotive_repair",
 * "tire_dealer_and_repair", "beauty_salon", "warung"…), so they are mapped onto
 * ours by rule, and a place whose category matches none of them is skipped
 * rather than filed as "other".
 *
 * Coverage is deliberately *not* marked: Overture is not OSM, and claiming a
 * tile as covered would stop the OSM sources from ever being asked about it.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { getStore } from "../server/lib/db.js";

const MIN_CONFIDENCE = 0.5;

/**
 * Overture primary category → our category id. Order matters: the first rule
 * whose pattern matches wins, so the specific ones ("ice_cream" is cafe, not
 * food; "karaoke" is entertainment, not nightlife) sit above the broad ones.
 */
const RULES = [
  // Not places anyone visits for a service: manufacturers, distributors,
  // consultancies, government offices, "hair supply" wholesalers.
  ["", /company|manufactur|distributor|wholesale|consultant|coaching|retirement|surgical|_supply|department_of|government|agency|office$/],
  ["vehicle", /automotive|auto_|tire|tyre|car_wash|motorcycle|car_repair|car_dealer|car_parts|bicycle_repair|vehicle_repair|boat_service|body_shop/],
  ["cafe", /ice_cream|gelato|coffee|cafe|tea_room|tea_house|bubble_tea|boba|juice|bakery|patisserie|dessert|donut|pastry/],
  ["entertainment", /karaoke|cinema|movie|theater|theatre|arcade|bowling|gym|fitness|amusement|billiard|escape_room|water_park|golf/],
  ["nightlife", /night_club|nightclub|\bbar\b|_bar$|^bar_|pub$|brewery|lounge|hookah|shisha/],
  ["service", /repair|workshop|bengkel|laundry|dry_clean|barber|salon|hair|tailor|locksmith|electrician|phone_store|mobile_phone|computer|appliance|printing|copy|photocopy|optician|optical|cobbler|shoe_repair|welding|upholster/],
  ["food", /restaurant|food|warung|bbq|barbecue|noodle|seafood|pizza|burger|sushi|ramen|chicken|steak|indonesian|japanese|chinese|korean|thai|padang|satay|sate|bakso|soto|catering|diner|eatery|buffet|grill|kebab|dim_sum/],
  ["stay", /hotel|hostel|guest_house|guesthouse|motel|resort|lodging|accommodation|villa|homestay|inn$|bed_and_breakfast|apartment_hotel/],
  ["worship", /mosque|masjid|church|temple|religious|place_of_worship|buddhist|hindu|synagogue|chapel|cathedral|vihara|pura$/],
  ["attraction", /tourist|attraction|museum|monument|landmark|art_gallery|gallery|zoo|theme_park|aquarium|historic|heritage|observation|sightseeing|cultural/],
  ["outdoor", /park$|_park|garden|beach|nature|recreation|hiking|campground|camping|lake|waterfall|playground|sports_field|stadium|swimming/],
  ["essential", /hospital|clinic|pharmacy|drugstore|doctor|dentist|medical|health|bank|atm|gas_station|petrol|fuel|police|post_office|fire_station|emergency|laboratory|veterinar/],
  ["transport", /train_station|railway|bus_station|bus_stop|airport|transportation|taxi|ferry|terminal|parking|car_rental/],
  ["education", /school|university|college|library|education|kindergarten|preschool|academy|course|tutoring|training/],
  ["shopping", /mall|shopping|store|shop$|supermarket|market|boutique|grocery|minimarket|convenience|department|retail|furniture|jewel|clothing|fashion|electronics|bookstore|pet_store|florist|toy/]
];

function mapCategory(primary) {
  const value = String(primary || "").toLowerCase();

  if (!value) {
    return "";
  }

  for (const [id, pattern] of RULES) {
    if (pattern.test(value)) {
      return id; // "" for the skip rule
    }
  }

  return "";
}

function socialTag(url) {
  const value = String(url || "").toLowerCase();

  if (value.includes("instagram.com")) return "contact:instagram";
  if (value.includes("facebook.com")) return "contact:facebook";
  if (value.includes("tiktok.com")) return "contact:tiktok";
  if (value.includes("twitter.com") || value.includes("x.com")) return "contact:twitter";

  return "";
}

function toPlace(feature) {
  const props = feature?.properties || {};
  const coords = feature?.geometry?.type === "Point" ? feature.geometry.coordinates : null;
  // The GERS id sits on the feature, not in its properties, in the CLI's
  // GeoJSON output. Without it every place collapsed onto one row.
  const overtureId = String(feature?.id || props.id || "").trim();

  if (!coords || coords.length < 2 || !overtureId) {
    return null;
  }

  const name = String(props.names?.primary || "").trim();
  const confidence = Number(props.confidence);
  const primary = props.categories?.primary || "";
  const categoryId = mapCategory(primary);

  if (!name || !categoryId || (Number.isFinite(confidence) && confidence < MIN_CONFIDENCE)) {
    return null;
  }

  const lng = Number(coords[0]);
  const lat = Number(coords[1]);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  const tags = { overture_category: primary };
  const website = (props.websites || [])[0];
  const phone = (props.phones || [])[0];

  if (website) tags.website = website;
  if (phone) tags.phone = phone;

  (props.socials || []).forEach((url) => {
    const key = socialTag(url);

    if (key && !tags[key]) {
      tags[key] = url;
    }
  });

  const address = props.addresses?.[0];
  const addressText = address
    ? [address.freeform, address.locality, address.region, address.postcode, address.country].filter(Boolean).join(", ")
    : "";

  return {
    id: `overture/${overtureId}`,
    osmType: null,
    osmId: null,
    name,
    lat,
    lng,
    categoryId,
    tagKey: "overture",
    tagValue: primary,
    tags,
    address: addressText,
    source: "overture"
  };
}

async function main() {
  const [, , file, ...rest] = process.argv;

  if (!file || file === "--help") {
    console.log("Usage: node scripts/import-overture.js <places.geojsonseq> [--export data/seed.json]");
    process.exit(file ? 0 : 1);
  }

  const exportIndex = rest.indexOf("--export");
  const exportPath = exportIndex >= 0 ? rest[exportIndex + 1] : "";

  const store = getStore();
  const before = store.stats().places;
  const batch = [];
  const byCategory = new Map();
  let read = 0;
  let skipped = 0;

  const lines = readline.createInterface({ input: fs.createReadStream(path.resolve(file)), crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) continue;
    read += 1;

    let feature;

    try {
      feature = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }

    const place = toPlace(feature);

    if (!place) {
      skipped += 1;
      continue;
    }

    batch.push(place);
    byCategory.set(place.categoryId, (byCategory.get(place.categoryId) || 0) + 1);

    if (batch.length >= 500) {
      store.upsertPlaces(batch.splice(0));
    }
  }

  if (batch.length) {
    store.upsertPlaces(batch);
  }

  const after = store.stats().places;
  console.log(`Read      : ${read} features, ${skipped} skipped (no name, no category match, or confidence < ${MIN_CONFIDENCE})`);
  console.log(`Imported  : ${[...byCategory].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${id} ${n}`).join(", ")}`);
  console.log(`Stored    : ${after} places total (+${after - before} new)`);

  if (exportPath) {
    const places = store.findPlacesInBox({ minLat: -90, maxLat: 90, minLng: -180, maxLng: 180 }, null, 200000);
    const resolved = path.resolve(exportPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), places }));
    console.log(`Exported  : ${places.length} places -> ${resolved}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
