// Task 3 — turning a daily series into comparable numbers.
//
// The decisive step is normalization. Raw counts cannot be compared across
// language editions, and raw year-over-year cannot even be trusted within one,
// because Wikipedia is losing human traffic at very different rates per edition
// (measured Sep 2025 -> Sep 2026: uk -24.6%, cs -12.6%, pl -8.8%, en -7.0%).
// Against that backdrop every topic looks like it is dying. Expressing a topic as
// views-per-million of its own project's traffic removes the platform trend and
// the size difference at once. It changes conclusions rather than refining them:
// Vietnamese "gold mining" is -9% raw but +20% normalized.
//
// Everything here works on COMPLETE months only. A partial month in the
// numerator (or a missing one in the denominator) manufactures a decline.

import { parse } from './dates.mjs';

const daysInMonth = (ym) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(4, 6), 0)).getUTCDate();
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/**
 * Roll a daily series up to months, flagging which months are complete.
 * A month is complete when every one of its calendar days is inside the window.
 */
export function monthlyRollup(series) {
  const acc = new Map();
  for (const { date, views } of series) {
    const ym = date.slice(0, 6);
    if (!acc.has(ym)) acc.set(ym, { month: ym, views: 0, days_present: 0, days_missing: 0 });
    const m = acc.get(ym);
    m.days_present += 1;
    if (views === null) m.days_missing += 1;
    else m.views += views;
  }
  return [...acc.values()]
    .sort((a, b) => (a.month < b.month ? -1 : 1))
    .map((m) => ({ ...m, complete: m.days_present === daysInMonth(m.month) }));
}

/**
 * Two adjacent blocks of `n` complete months, most recent last.
 * Returns null when there is not enough history for an honest comparison.
 */
export function trailingBlocks(monthly, n = 12) {
  const complete = monthly.filter((m) => m.complete);
  if (complete.length < 2 * n) return null;
  const recent = complete.slice(-n);
  const prior = complete.slice(-2 * n, -n);
  return { recent, prior, months_available: complete.length };
}

const pct = (from, to) => (from > 0 ? (to / from - 1) * 100 : null);

/**
 * Compare a topic's two most recent 12-month blocks, raw and normalized.
 *
 * `projectMonths` maps YYYYMM -> total project views. Months absent from it are
 * dropped from BOTH sides, so numerator and denominator always cover the same
 * span.
 */
export function compareBlocks(monthly, projectMonths, n = 12) {
  const blocks = trailingBlocks(monthly, n);
  if (!blocks) {
    return {
      insufficient_history: true,
      months_available: monthly.filter((m) => m.complete).length,
      months_required: 2 * n,
    };
  }

  const usable = (block) => block.filter((m) => projectMonths?.[m.month] > 0);
  const recent = usable(blocks.recent);
  const prior = usable(blocks.prior);

  const rawRecent = sum(blocks.recent.map((m) => m.views));
  const rawPrior = sum(blocks.prior.map((m) => m.views));

  const out = {
    window: {
      prior: [blocks.prior[0].month, blocks.prior.at(-1).month],
      recent: [blocks.recent[0].month, blocks.recent.at(-1).month],
    },
    raw: { prior: rawPrior, recent: rawRecent, yoy_pct: pct(rawPrior, rawRecent) },
    days_missing: sum(blocks.recent.concat(blocks.prior).map((m) => m.days_missing)),
  };

  // Normalized figures need project totals for every month on both sides.
  if (recent.length === blocks.recent.length && prior.length === blocks.prior.length) {
    const perMillion = (block) =>
      (sum(block.map((m) => m.views)) / sum(block.map((m) => projectMonths[m.month]))) * 1e6;
    const nPrior = perMillion(prior);
    const nRecent = perMillion(recent);
    out.normalized = {
      unit: 'views per million project views',
      prior: +nPrior.toFixed(2),
      recent: +nRecent.toFixed(2),
      yoy_pct: pct(nPrior, nRecent),
    };
  } else {
    out.normalized = {
      unavailable: true,
      reason: 'project totals missing for some months in the comparison window',
    };
  }

  return out;
}

/** Median daily views over the trailing `days` of the series. */
export function medianDaily(series, days = 90) {
  const tail = series.slice(-days).map((p) => p.views ?? 0);
  if (!tail.length) return null;
  const s = [...tail].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Round percentages for display without pretending to precision we lack. */
export const pct1 = (x) => (x === null || x === undefined ? null : +x.toFixed(1));

export { sum, daysInMonth, parse };
