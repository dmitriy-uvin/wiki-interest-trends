// Disk cache for view series.
//
// Two reasons this exists. First, follow-up questions ("now add Hungarian",
// "redo without the spike") must not re-fetch anything. Second, Wikimedia asks
// callers to be polite, and a multi-language scan is dozens of requests.
//
// Layout: one NDJSON file of {d, v} per series, plus a sibling .meta.json
// recording which date range it covers. Requests are contiguous ranges, so only
// the missing head and tail are ever fetched.

import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { addDays, today, DATA_LAG_DAYS } from './dates.mjs';

/** Days at the end of a series that may still be revised upstream. */
const VOLATILE_DAYS = DATA_LAG_DAYS + 1;

/**
 * Cache can be turned off entirely for debugging, so a run always hits the live
 * API and nothing is written to disk. Checked at call time rather than module
 * load so the CLI flag can set it.
 */
const disabled = () => process.env.WT_NO_CACHE === '1';

export function cacheDir() {
  if (process.env.WT_CACHE_DIR) return process.env.WT_CACHE_DIR;
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'wiki-interest-trends');
}

const keyOf = (p) =>
  createHash('sha1')
    .update(JSON.stringify([p.project, p.title, p.access, p.agent, p.granularity]))
    .digest('hex')
    .slice(0, 20);

const paths = (p) => {
  const dir = path.join(cacheDir(), 'series');
  const k = keyOf(p);
  return { dir, data: path.join(dir, `${k}.ndjson`), meta: path.join(dir, `${k}.meta.json`) };
};

async function readJson(f) {
  try {
    return JSON.parse(await readFile(f, 'utf8'));
  } catch {
    return null;
  }
}

/** Returns { points: Map<date, views>, meta } for whatever is already cached. */
export async function load(params) {
  if (disabled()) return { points: new Map(), meta: null };
  const { data, meta: metaPath } = paths(params);
  const meta = await readJson(metaPath);
  if (!meta) return { points: new Map(), meta: null };
  let raw = '';
  try {
    raw = await readFile(data, 'utf8');
  } catch {
    return { points: new Map(), meta: null };
  }
  const points = new Map();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const { d, v } = JSON.parse(line);
    points.set(d, v);
  }
  return { points, meta };
}

export async function save(params, points, coveredFrom, coveredTo) {
  if (disabled()) return;
  const { dir, data, meta } = paths(params);
  await mkdir(dir, { recursive: true });
  const lines = [...points.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([d, v]) => JSON.stringify({ d, v }))
    .join('\n');
  await writeFile(data, lines + (lines ? '\n' : ''), 'utf8');
  await writeFile(
    meta,
    JSON.stringify({ ...params, from: coveredFrom, to: coveredTo, updated: new Date().toISOString() }, null, 2),
    'utf8',
  );
}

/**
 * Which sub-ranges of [from, to] still need fetching?
 *
 * Anything older than the volatile tail is treated as final and never re-fetched.
 * The last few days are always re-fetched, because upstream still revises them.
 */
export function gapsFor(meta, from, to) {
  if (!meta) return [[from, to]];
  const gaps = [];
  if (from < meta.from) gaps.push([from, addDays(meta.from, -1)]);
  if (to > meta.to) gaps.push([addDays(meta.to, 1), to]);

  const volatileStart = addDays(today(), -VOLATILE_DAYS);
  if (to >= volatileStart) {
    const start = from > volatileStart ? from : volatileStart;
    // Merge into an existing tail gap rather than issuing two adjacent requests.
    const tail = gaps.find(([, g1]) => g1 >= addDays(start, -1));
    if (tail) tail[0] = tail[0] < start ? tail[0] : start;
    else gaps.push([start, to]);
  }
  return gaps.filter(([a, b]) => a <= b).sort(([a], [b]) => (a < b ? -1 : 1));
}

export async function cacheStats() {
  const dir = path.join(cacheDir(), 'series');
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.ndjson'));
    let bytes = 0;
    for (const f of files) bytes += (await stat(path.join(dir, f))).size;
    return { series: files.length, bytes, dir };
  } catch {
    return { series: 0, bytes: 0, dir };
  }
}
