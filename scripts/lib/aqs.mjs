// Task 2 — the pageviews client.
//
// Wikimedia's Analytics Query Service, wrapped so the rest of the skill never
// has to remember its quirks:
//
//   * agent=user by default. Bots are roughly a third of raw traffic (English
//     "Astronomy", Aug 2026: 38,448 all-agents vs 24,843 user), so all-agents
//     measures crawlers as much as people.
//   * Days with no data are OMITTED from the response, not returned as zero. A
//     naive average over the returned items silently overstates a quiet article,
//     so every series is reindexed onto a full date axis here.
//   * "No data" arrives as either 404 or 200-with-an-empty-list. Both mean the
//     same thing and both are handled.
//   * Titles are case-sensitive on the first letter and use underscores.
//   * Monthly granularity returns the CURRENT, INCOMPLETE month. Comparing that
//     against full months manufactures a decline, so it is dropped.

import { getJson, NO_DATA, mapLimit, trace } from './http.mjs';
import * as cache from './cache.mjs';
import { eachDay, lastCompleteMonth, monthStart, DATA_FLOOR } from './dates.mjs';

const BASE = 'https://wikimedia.org/api/rest_v1/metrics/pageviews';

/** Underscores, then percent-encode everything including slashes. */
export const encodeTitle = (t) => encodeURIComponent(String(t).replace(/ /g, '_'));

const itemsOf = (res) => (res === NO_DATA ? [] : (res?.items ?? []));

/**
 * Daily views for one article, on a complete date axis.
 *
 * Absent days come back as null rather than 0, because the API cannot tell us
 * which it is. Callers that need a number treat null as 0 but must surface
 * `days_missing` so the distinction stays visible.
 */
export async function articleSeries({
  project,
  title,
  from,
  to,
  agent = 'user',
  access = 'all-access',
} = {}) {
  if (from < DATA_FLOOR) from = DATA_FLOOR; // pageview data starts 2015-07-01
  const params = { project, title, access, agent, granularity: 'daily' };

  const { points, meta } = await cache.load(params);
  const gaps = cache.gapsFor(meta, from, to);
  trace(
    'series',
    `${project}/${title}`,
    `want ${from}..${to}`,
    meta ? `cached ${meta.from}..${meta.to}` : 'no cache',
    gaps.length ? `fetch ${gaps.map((g) => g.join('..')).join(',')}` : 'FULLY CACHED',
  );

  const fetched = [];
  for (const [a, b] of gaps) {
    const url = `${BASE}/per-article/${project}/${access}/${agent}/${encodeTitle(title)}/daily/${a}/${b}`;
    const res = await getJson(url);
    for (const it of itemsOf(res)) points.set(it.timestamp.slice(0, 8), it.views);
    fetched.push([a, b]);
    // Record absence explicitly as null, so the range is not re-fetched forever
    // AND "the API had no row for this day" stays distinguishable from "0 views".
    for (const d of eachDay(a, b)) if (!points.has(d)) points.set(d, null);
  }

  if (fetched.length) {
    const lo = meta ? (meta.from < from ? meta.from : from) : from;
    const hi = meta ? (meta.to > to ? meta.to : to) : to;
    await cache.save(params, points, lo, hi);
  }

  const axis = eachDay(from, to);
  const series = axis.map((d) => ({ date: d, views: points.has(d) ? points.get(d) : null }));
  // null means "no row from the API". Aggregations treat it as 0 but must report
  // days_missing alongside, so a sparse series is never mistaken for a dense one.
  return {
    project,
    title,
    agent,
    access,
    from,
    to,
    series,
    days: axis.length,
    days_missing: series.filter((p) => p.views === null).length,
    days_zero: series.filter((p) => p.views === 0).length,
    fetched_ranges: fetched,
    from_cache: fetched.length === 0,
  };
}

/**
 * Total monthly views for a whole project, the denominator that makes two
 * language editions comparable. The incomplete current month is excluded.
 */
export async function projectTotalsMonthly({ project, from, to, agent = 'user', access = 'all-access' } = {}) {
  const end = to > lastCompleteMonth() ? lastCompleteMonth() : monthStart(to);
  const start = monthStart(from);
  const params = { project, title: '__PROJECT_TOTAL__', access, agent, granularity: 'monthly' };

  const { points, meta } = await cache.load(params);
  const gaps = cache.gapsFor(meta, start, end);

  let fetchedAny = false;
  for (const [a, b] of gaps) {
    const url = `${BASE}/aggregate/${project}/${access}/${agent}/monthly/${a}/${b}`;
    const res = await getJson(url);
    for (const it of itemsOf(res)) points.set(it.timestamp.slice(0, 6), it.views);
    fetchedAny = true;
  }
  if (fetchedAny) {
    const lo = meta && meta.from < start ? meta.from : start;
    const hi = meta && meta.to > end ? meta.to : end;
    await cache.save(params, points, lo, hi);
  }

  return {
    project,
    months: Object.fromEntries([...points.entries()].filter(([m]) => m >= start.slice(0, 6) && m <= end.slice(0, 6))),
    complete_through: end,
  };
}

/** Fetch several articles politely. Wikimedia asks callers not to hammer it. */
export async function manyArticleSeries(specs, { concurrency = 4 } = {}) {
  return mapLimit(specs, concurrency, async (s) => {
    try {
      return await articleSeries(s);
    } catch (e) {
      return { project: s.project, title: s.title, error: e.code ?? 'fetch_failed', message: e.message };
    }
  });
}
