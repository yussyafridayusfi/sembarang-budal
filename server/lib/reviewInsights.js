/**
 * What people say about a place, derived from review text we actually have.
 *
 * Everything here is counted, never guessed. Each finding carries how many
 * reviews mentioned it and the panel shows that number, so "Parking: difficult
 * (2 of 5 reviews)" reads as what it is - two people said so - rather than as a
 * fact about the place. A field with no mentions is null, and the panel says
 * "not enough data". No reviews at all means no insights at all.
 *
 * The lexicon is bilingual because Indonesian reviews mix both, and short on
 * purpose: it aims at the handful of things people consistently comment on -
 * service speed, taste, price, parking, crowd, waiting, payment, how hard the
 * place is to find - not at general sentiment analysis. Google's own review
 * summary, when the Places API provides it, is preferred for the prose summary
 * because it is drawn from all reviews rather than the five the API returns.
 */

function sentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
}

function lower(text) {
  return String(text || "").toLowerCase();
}

/** Count reviews (not sentences) in which any pattern matches. */
function countReviews(reviews, patterns) {
  let hits = 0;

  for (const review of reviews) {
    const text = lower(review.text);

    if (patterns.some((re) => re.test(text))) {
      hits += 1;
    }
  }

  return hits;
}

const POSITIVE = [
  /\b(enak|lezat|mantap|mantul|nikmat|recommended|rekomen|worth it|puas|ramah|bersih|nyaman|cozy|murah|terjangkau|cepat|fresh|segar|delicious|tasty|great|good|friendly|clean|comfortable|cheap|affordable|fast|love|suka|favorit|juara|top|best)\b/
];

const NEGATIVE = [
  /\b(kecewa|mengecewakan|kurang|lama|lambat|mahal|kotor|jorok|bau|hambar|asin|keasinan|dingin|basi|antri|antre|penuh|sesak|berisik|bising|sempit|jutek|cuek|rude|slow|dirty|expensive|overpriced|bad|worst|disappointed|disappointing|cold|stale|noisy|cramped|salty|bland|small portion|porsi kecil|sedikit|tidak ramah|gak ramah|ga ramah|tdk ramah)\b/
];

/** Complaint themes people repeat, each with the phrasing that signals it. */
const COMPLAINTS = [
  { label: "Slow service", patterns: [/\b(lama|lambat|slow|nunggu lama|menunggu lama|lelet|pelayanan lama|waiting)\b/] },
  { label: "Inconsistent taste", patterns: [/\b(kadang|tidak konsisten|inkonsisten|beda rasa|rasa berubah|hit or miss|inconsistent|hambar|keasinan|kurang bumbu|terlalu manis|terlalu asin)\b/] },
  { label: "Pricey", patterns: [/\b(mahal|overpriced|pricey|expensive|kemahalan|harga naik)\b/] },
  { label: "Hard to park", patterns: [/\b(parkir (susah|sulit|sempit|penuh|terbatas|ribet|bayar)|susah parkir|sulit parkir|no parking|parking (difficult|limited|hard))\b/] },
  { label: "Long wait", patterns: [/\b(antri|antre|antrian|antrean|ngantri|queue|long wait|waiting list)\b/] },
  { label: "Crowded / noisy", patterns: [/\b(ramai|penuh|sesak|berisik|bising|crowded|noisy|packed)\b/] },
  { label: "Cleanliness", patterns: [/\b(kotor|jorok|bau|lengket|dirty|smelly|unclean)\b/] },
  { label: "Small portions", patterns: [/\b(porsi (kecil|sedikit|dikit)|small portion|porsinya kecil)\b/] },
  { label: "Unfriendly staff", patterns: [/\b(jutek|cuek|judes|tidak ramah|gak ramah|ga ramah|tdk ramah|rude|unfriendly)\b/] }
];

const PRAISE = [
  { label: "Tasty food", patterns: [/\b(enak|lezat|nikmat|mantap|mantul|delicious|tasty|juara)\b/] },
  { label: "Friendly staff", patterns: [/\b(ramah|sopan|helpful|friendly|pelayanan (baik|bagus|ramah|cepat))\b/] },
  { label: "Clean & comfortable", patterns: [/\b(bersih|nyaman|cozy|adem|sejuk|clean|comfortable|cosy)\b/] },
  { label: "Good value", patterns: [/\b(murah|terjangkau|worth it|sesuai harga|affordable|cheap|value)\b/] },
  { label: "Fast service", patterns: [/\b(cepat|gercep|fast|quick|tidak lama|ga lama|gak lama)\b/] },
  { label: "Generous portions", patterns: [/\b(porsi (besar|banyak|jumbo|melimpah)|big portion|large portion|kenyang)\b/] },
  { label: "Good atmosphere", patterns: [/\b(suasana|tempatnya (bagus|enak|asik|asyik)|instagramable|instagrammable|view|pemandangan|ambience|ambiance|vibes?)\b/] }
];

function pickTheme(reviews, themes) {
  return themes
    .map((theme) => ({ label: theme.label, mentions: countReviews(reviews, theme.patterns) }))
    .filter((theme) => theme.mentions > 0)
    .sort((a, b) => b.mentions - a.mentions);
}

/** "10-20 menit", "20 min", "setengah jam" - a waiting-time figure near a waiting word. */
function waitingTime(reviews) {
  const figures = [];
  let mentions = 0;

  for (const review of reviews) {
    const text = lower(review.text);

    if (!/\b(antri|antre|antrian|antrean|nunggu|menunggu|tunggu|wait|waiting|queue)\b/.test(text)) {
      continue;
    }

    mentions += 1;
    const minutes = [...text.matchAll(/(\d{1,3})\s*(?:-|–|sampai|to)?\s*(\d{1,3})?\s*(menit|min|mins|minutes?)\b/g)];

    for (const m of minutes) {
      figures.push(Number(m[1]));

      if (m[2]) {
        figures.push(Number(m[2]));
      }
    }

    if (/\b(setengah jam|half an hour)\b/.test(text)) {
      figures.push(30);
    }

    if (/\b(1 jam|satu jam|sejam|an hour|1 hour)\b/.test(text)) {
      figures.push(60);
    }
  }

  if (!mentions) {
    return null;
  }

  const valid = figures.filter((n) => n > 0 && n <= 180).sort((a, b) => a - b);

  if (valid.length) {
    const low = valid[0];
    const high = valid[valid.length - 1];
    return { label: low === high ? `about ${low} min` : `${low}–${high} min`, mentions };
  }

  return { label: "waiting mentioned", mentions };
}

function crowd(reviews) {
  const busy = countReviews(reviews, [/\b(ramai|penuh|sesak|rame|crowded|packed|busy|antri|antre)\b/]);
  const quiet = countReviews(reviews, [/\b(sepi|tenang|quiet|sunyi|santai|tidak ramai|ga ramai|gak ramai)\b/]);

  if (!busy && !quiet) {
    return null;
  }

  if (busy && quiet) {
    return { label: "Moderate", mentions: busy + quiet, note: `${busy} said busy, ${quiet} said quiet` };
  }

  return busy ? { label: "Crowded", mentions: busy } : { label: "Quiet", mentions: quiet };
}

function parking(reviews) {
  const hard = countReviews(reviews, [
    /\b(parkir (susah|sulit|sempit|penuh|terbatas|ribet|bayar|mahal)|susah parkir|sulit parkir|parkiran (sempit|penuh|kecil)|parking (difficult|limited|hard|tight))\b/
  ]);
  const easy = countReviews(reviews, [
    /\b(parkir (luas|mudah|gampang|gratis|lega|banyak)|parkiran (luas|lega|besar)|parking (easy|ample|plenty|free)|easy parking)\b/
  ]);

  if (!hard && !easy) {
    return null;
  }

  if (hard && easy) {
    return { label: "Limited", mentions: hard + easy, note: `${hard} found it hard, ${easy} found it easy` };
  }

  return hard ? { label: "Difficult", mentions: hard } : { label: "Easy", mentions: easy };
}

function payment(reviews) {
  const methods = [
    { label: "QRIS", patterns: [/\bqris\b/] },
    { label: "cash", patterns: [/\b(cash|tunai|uang tunai|cash only|hanya tunai|harus tunai)\b/] },
    { label: "card", patterns: [/\b(kartu|debit|credit|kredit|card|gesek)\b/] },
    { label: "e-wallet", patterns: [/\b(gopay|ovo|dana|shopeepay|e-wallet|ewallet|linkaja)\b/] }
  ];

  const found = methods
    .map((method) => ({ label: method.label, mentions: countReviews(reviews, method.patterns) }))
    .filter((method) => method.mentions > 0);

  if (!found.length) {
    return null;
  }

  return {
    label: found.map((m) => m.label).join(" / "),
    mentions: Math.max(...found.map((m) => m.mentions))
  };
}

function findability(reviews) {
  const hard = countReviews(reviews, [
    /\b(susah dicari|sulit dicari|susah ditemukan|tersembunyi|nyempil|masuk gang|agak tersembunyi|hidden|hard to find|tucked away)\b/
  ]);
  const easy = countReviews(reviews, [
    /\b(mudah dicari|gampang dicari|strategis|pinggir jalan|di pinggir jalan|easy to find|strategic|dekat)\b/
  ]);

  if (!hard && !easy) {
    return null;
  }

  return hard >= easy ? { label: "Hard to find", mentions: hard } : { label: "Easy to find", mentions: easy };
}

/**
 * Dishes people name. A menu item is a capitalised phrase or a food noun that
 * appears next to a recommending word ("wajib coba", "recommended", "enak").
 * Counted per review so one enthusiastic list does not dominate.
 */
function bestMenu(reviews) {
  const counts = new Map();
  const foodNoun =
    "(?:mie|mi|nasi|ayam|sate|soto|bakso|rawon|gado|es|kopi|teh|roti|martabak|pizza|burger|steak|sushi|ramen|udang|cumi|ikan|bebek|tahu|tempe|dimsum|pangsit|seblak|batagor|siomay|pempek|rujak|lontong|pecel|gudeg|rendang|dendeng|sambal|jus|juice|latte|cappuccino|americano|matcha|croffle|croissant|donat|cake|kue|brownies|pudding|cheesecake|tiramisu)";
  const dishRe = new RegExp(`\\b(${foodNoun}(?:\\s+[a-z][a-z-]+|\\s+\\d{1,2}){0,3})`, "gi");
  const recommendRe =
    /\b(wajib coba|wajib dicoba|recommended|rekomen|favorit|paling enak|enak banget|juara|best seller|must try|signature|andalan|the best|my favorite|favourite)\b/i;
  // Words that trail a dish name without being part of it - clitics ("nya"),
  // connectives, and the adjectives people attach ("enak", "segar").
  const trailing =
    /\s+(nya|itu|ini|yang|dan|juga|banget|sangat|enak|lezat|mantap|mantul|nikmat|segar|fresh|recommended|rekomen|favorit|deh|sih|dong|sekali|juara|gurih|pedas|manis|dingin|hangat|panas)$/i;

  for (const review of reviews) {
    const text = String(review.text || "");
    const seen = new Set();

    for (const sentence of sentences(text)) {
      // A dish named while complaining ("mie nya keasinan") is not a
      // recommendation; only sentences that are not negative count here.
      if (NEGATIVE.some((re) => re.test(lower(sentence)))) {
        continue;
      }

      const recommends = recommendRe.test(sentence);
      const dishes = [...sentence.matchAll(dishRe)].map((m) => m[1].trim().toLowerCase());

      for (const dish of dishes) {
        // Trim trailing filler repeatedly ("mie gacoan nya enak" -> "mie gacoan").
        let clean = dish;
        let previous;

        do {
          previous = clean;
          clean = clean.replace(trailing, "").trim();
        } while (clean !== previous);

        if (!clean || seen.has(clean)) {
          continue;
        }

        // A bare "nasi" or "es" is not a dish; require two words unless recommended.
        if (clean.split(" ").length === 1 && !recommends) {
          continue;
        }

        seen.add(clean);
        counts.set(clean, (counts.get(clean) || 0) + (recommends ? 2 : 1));
      }
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([item, score]) => ({ item: item.replace(/\b\w/g, (c) => c.toUpperCase()), score }));
}

function popularity(reviewCount) {
  if (typeof reviewCount !== "number") {
    return null;
  }

  if (reviewCount >= 5000) return { label: "Very popular", note: `${reviewCount.toLocaleString("id-ID")} Google reviews` };
  if (reviewCount >= 1000) return { label: "Popular", note: `${reviewCount.toLocaleString("id-ID")} Google reviews` };
  if (reviewCount >= 100) return { label: "Well known", note: `${reviewCount.toLocaleString("id-ID")} Google reviews` };
  if (reviewCount >= 10) return { label: "Some reviews", note: `${reviewCount} Google reviews` };
  return { label: "Few reviews", note: `${reviewCount} Google reviews` };
}

/** Sentences to quote as pros / cons - real reviewer words, not paraphrase. */
function quotes(reviews, patterns, limit = 3) {
  const out = [];

  for (const review of reviews) {
    for (const sentence of sentences(review.text)) {
      const text = lower(sentence);

      if (patterns.some((re) => re.test(text)) && sentence.length <= 160) {
        out.push({ text: sentence, author: review.author || "" });
        break;
      }
    }

    if (out.length >= limit) {
      break;
    }
  }

  return out;
}

/**
 * Everything derived from a set of reviews, with counts.
 *
 * `reviewCount` is the place's total on Google; `reviews` are the texts we
 * actually have (at most five from the Places API). The two are kept apart so
 * the panel never implies that five texts speak for ten thousand ratings.
 */
export function analyzeReviews(reviews = [], { reviewCount = null, googleSummary = "" } = {}) {
  const usable = (reviews || []).filter((review) => String(review.text || "").trim().length >= 8);

  if (!usable.length) {
    return {
      basedOn: 0,
      summary: googleSummary || "",
      pros: [],
      cons: [],
      complaints: [],
      praise: [],
      bestMenu: [],
      waitingTime: null,
      crowd: null,
      parking: null,
      payment: null,
      findability: null,
      popularity: popularity(reviewCount)
    };
  }

  const praise = pickTheme(usable, PRAISE);
  const complaints = pickTheme(usable, COMPLAINTS);

  return {
    basedOn: usable.length,
    summary: googleSummary || "",
    pros: quotes(usable, POSITIVE),
    cons: quotes(usable, NEGATIVE),
    praise,
    complaints,
    bestMenu: bestMenu(usable),
    waitingTime: waitingTime(usable),
    crowd: crowd(usable),
    parking: parking(usable),
    payment: payment(usable),
    findability: findability(usable),
    popularity: popularity(reviewCount)
  };
}

/**
 * The "at a glance" grid. Each cell is `{ value, source, note }` or null, and
 * the source is the truth about where it came from, in priority order:
 * Google's structured attribute, then an OSM tag, then a count of review
 * mentions. The panel prints the source next to the value.
 */
export function buildAttributes({ google = null, osmTags = {}, insights = null } = {}) {
  const fromReviews = (finding, extra = "") =>
    finding
      ? {
          value: finding.label,
          source: "reviews",
          note: [finding.note, `${finding.mentions} of ${insights.basedOn} reviews`, extra].filter(Boolean).join(" · ")
        }
      : null;

  // Atmosphere: Google's booleans first, then OSM, then what reviewers praised.
  let atmosphere = null;
  const atmos = [];

  if (google?.attributes) {
    const a = google.attributes;
    if (a.goodForChildren === true) atmos.push("family-friendly");
    if (a.goodForGroups === true) atmos.push("good for groups");
    if (a.outdoorSeating === true) atmos.push("outdoor seating");
    if (a.liveMusic === true) atmos.push("live music");
    if (a.reservable === true) atmos.push("takes reservations");
  }

  if (atmos.length) {
    atmosphere = { value: atmos.join(", "), source: "google", note: "Google place attributes" };
  } else if (osmTags.outdoor_seating === "yes") {
    atmosphere = { value: "outdoor seating", source: "osm", note: "OpenStreetMap tag" };
  } else if (insights?.praise?.some((p) => p.label === "Good atmosphere")) {
    const p = insights.praise.find((x) => x.label === "Good atmosphere");
    atmosphere = fromReviews({ label: "Praised by reviewers", mentions: p.mentions });
  }

  let parkingCell = null;

  if (google?.attributes?.parking?.length) {
    parkingCell = { value: google.attributes.parking.join(", "), source: "google", note: "Google place attributes" };
  } else if (osmTags.parking) {
    parkingCell = { value: String(osmTags.parking).replace(/_/g, " "), source: "osm", note: "OpenStreetMap tag" };
  } else {
    parkingCell = fromReviews(insights?.parking);
  }

  let paymentCell = null;
  const osmPayments = Object.keys(osmTags)
    .filter((key) => key.startsWith("payment:") && /^(yes|only)$/i.test(String(osmTags[key])))
    .map((key) => key.replace("payment:", "").replace(/_/g, " "));

  if (google?.attributes?.payment?.length) {
    paymentCell = { value: google.attributes.payment.join(", "), source: "google", note: "Google place attributes" };
  } else if (osmPayments.length) {
    paymentCell = { value: osmPayments.join(", "), source: "osm", note: "OpenStreetMap tags" };
  } else {
    paymentCell = fromReviews(insights?.payment);
  }

  const crowdCell = fromReviews(insights?.crowd);
  const waitingCell = fromReviews(insights?.waitingTime);
  const locationCell = fromReviews(insights?.findability);

  const popularityCell = insights?.popularity
    ? { value: insights.popularity.label, source: "google", note: insights.popularity.note }
    : null;

  return {
    atmosphere,
    parking: parkingCell,
    waitingTime: waitingCell,
    crowd: crowdCell,
    location: locationCell,
    payment: paymentCell,
    popularity: popularityCell
  };
}
