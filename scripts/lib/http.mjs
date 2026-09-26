// Shared HTTP layer for all Wikimedia API calls.
//
// Why this file exists: Wikimedia returns 403 for any request without a
// descriptive User-Agent, and distinguishes "no data" (404) from real failures.
// Both facts are easy to get wrong in ad-hoc fetch calls, so every request in
// this skill goes through here.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.1.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, '..', '..', 'tests', 'fixtures');

/** Wikimedia blocks requests without a contact-bearing User-Agent. */
export function userAgent() {
  const contact = process.env.WT_CONTACT?.trim();
  if (!contact) {
    throw new WtError(
      'missing_contact',
      'WT_CONTACT is not set. Wikimedia rejects requests without contact info.',
      { fix: 'export WT_CONTACT="you@example.com" (an email or project URL)' },
    );
  }
  return `wiki-interest-trends/${VERSION} (${contact})`;
}

export class WtError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
  toJSON() {
    return { error: this.code, message: this.message, ...(this.fix && { fix: this.fix }) };
  }
}

/** Sentinel for "the API answered correctly, and the answer is 'no data'". */
export const NO_DATA = Symbol('NO_DATA');

/**
 * Request tracing, on stderr so it never contaminates the JSON on stdout.
 * Set WT_DEBUG=1 to see every call, its status and its timing — the difference
 * between "the number is wrong" and "we never fetched what you think we did".
 */
const DEBUG = () => process.env.WT_DEBUG === '1';
let callCount = 0;
export const requestCount = () => callCount;
export function trace(...parts) {
  if (DEBUG()) process.stderr.write(`[wt] ${parts.join(' ')}\n`);
}
/** Shorten a Wikimedia URL to the part that identifies the request. */
const brief = (url) =>
  String(url)
    .replace('https://wikimedia.org/api/rest_v1/metrics/pageviews/', 'pageviews/')
    .replace(/https:\/\/([a-z-]+)\.wikipedia\.org\/w\/api\.php\?/, '$1.wiki?')
    .replace('https://www.wikidata.org/w/api.php?', 'wikidata?')
    .slice(0, 150);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fixturePath(url) {
  return path.join(FIXTURE_DIR, createHash('sha1').update(url).digest('hex').slice(0, 16) + '.json');
}

/**
 * GET a JSON API endpoint.
 * Returns parsed JSON, or NO_DATA when the endpoint reports no data (HTTP 404).
 * Retries 429 and 5xx with exponential backoff; everything else throws.
 */
export async function getJson(url, { retries = 4, timeoutMs = 20_000 } = {}) {
  if (process.env.WT_FIXTURES === '1') {
    trace('FIXTURE', brief(url));
    try {
      const body = JSON.parse(await readFile(fixturePath(url), 'utf8'));
      return body?.__wt_no_data ? NO_DATA : body;
    } catch (e) {
      if (e.code === 'ENOENT') {
        throw new WtError('fixture_missing', `No fixture recorded for ${url}`, {
          fix: 'record fixtures by re-running the same command with WT_RECORD=1 and no WT_FIXTURES',
        });
      }
      throw e;
    }
  }

  const record = process.env.WT_RECORD === '1';
  const save = async (payload) => {
    if (!record) return;
    await mkdir(FIXTURE_DIR, { recursive: true });
    await writeFile(fixturePath(url), JSON.stringify(payload), 'utf8');
  };

  const headers = { 'User-Agent': userAgent(), Accept: 'application/json' };
  let lastErr;
  const started = Date.now();

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(500 * 2 ** (attempt - 1), 8000) + Math.random() * 250);

    const ctl = AbortSignal.timeout(timeoutMs);
    let res;
    try {
      res = await fetch(url, { headers, signal: ctl });
    } catch (e) {
      lastErr = new WtError('network', `Request failed: ${e.message}`, { url });
      continue;
    }

    callCount += 1;
    trace(`HTTP ${res.status}`, `${Date.now() - started}ms`, brief(url));

    // 404 is a legitimate answer here: "valid request, no data for it".
    if (res.status === 404) {
      await save({ __wt_no_data: true });
      return NO_DATA;
    }

    if (res.status === 429 || res.status >= 500) {
      lastErr = new WtError('upstream', `HTTP ${res.status} from Wikimedia`, { url });
      continue;
    }

    if (res.status === 403) {
      throw new WtError('forbidden', 'Wikimedia returned 403 — usually a User-Agent problem.', {
        url,
        fix: 'Check that WT_CONTACT is set to a real email or project URL.',
      });
    }

    if (!res.ok) throw new WtError('http', `HTTP ${res.status} from ${url}`, { url });

    try {
      const body = await res.json();
      await save(body);
      return body;
    } catch {
      throw new WtError('bad_json', `Response was not valid JSON: ${url}`, { url });
    }
  }

  throw lastErr;
}

/** Map over items with bounded concurrency. Wikimedia asks callers to be polite. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
