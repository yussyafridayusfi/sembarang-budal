const USER_AGENT =
  process.env.OSM_USER_AGENT ||
  "sembarang-budal/2.0 (https://github.com/yussyafridayusfi/sembarang-budal)";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch with a hard timeout. Upstream OSM services regularly hang; without a
 * timeout a single stalled request burns the whole serverless invocation.
 */
export async function fetchWithTimeout(url, { timeoutMs = 8000, ...options } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: options.signal || controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        ...(options.headers || {})
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, options = {}) {
  const response = await fetchWithTimeout(url, options);

  if (!response.ok) {
    throw new HttpError(response.status, `${options.label || url} responded ${response.status}`);
  }

  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(502, `${options.label || url} returned a non-JSON body`);
  }
}

/**
 * Retry on transient upstream failures only (timeouts, 429, 5xx). Overpass in
 * particular answers 429/504 under load and succeeds on a later attempt.
 */
export async function fetchJsonWithRetry(
  url,
  { attempts = 2, backoffMs = 600, retryTimeouts = true, ...options } = {}
) {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetchJson(url, options);
    } catch (error) {
      lastError = error;
      const status = error.status || 0;
      const timedOut = error.name === "AbortError";
      // Callers working against a shared deadline pass `retryTimeouts: false`:
      // re-running a request that already used its whole timeout spends budget
      // the remaining work needs, whereas a 429/503 usually succeeds at once.
      const retryable = timedOut ? retryTimeouts : status === 429 || status >= 500;

      if (!retryable || attempt === attempts - 1) {
        break;
      }

      await sleep(backoffMs * (attempt + 1));
    }
  }

  throw lastError;
}

/**
 * Run tasks with bounded concurrency. Upstream APIs rate-limit per IP
 * (Overpass allows ~2 slots, Nominatim ~1 request/second), so fanning out
 * without a limit turns into a wall of 429s.
 */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;

      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { error };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => run())
  );

  return results;
}

/**
 * A shared deadline for a request. Discovery queries as many sources as it can
 * fit before the deadline, then returns whatever it has instead of failing.
 */
export function createDeadline(totalMs) {
  const endsAt = Date.now() + totalMs;

  return {
    remaining() {
      return Math.max(0, endsAt - Date.now());
    },
    expired() {
      return Date.now() >= endsAt;
    },
    budget(maxMs) {
      return Math.min(maxMs, Math.max(0, endsAt - Date.now()));
    }
  };
}
