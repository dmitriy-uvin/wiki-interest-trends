// Tasks 2-3 tests: rollup, normalization and the traps that make naive
// implementations report confident nonsense.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlyRollup, trailingBlocks, compareBlocks, medianDaily } from '../scripts/lib/series.mjs';
import { sparkline, monthlySparkline } from '../scripts/lib/sparkline.mjs';
import { gapsFor } from '../scripts/lib/cache.mjs';
import { addMonths, completeMonthWindow, lastCompleteMonth, sinceToMonths, endOfMonth, eachDay } from '../scripts/lib/dates.mjs';

/** Build a daily series of constant views across whole months. */
function daily(fromMonth, months, viewsPerDay) {
  const out = [];
  for (let i = 0; i < months; i++) {
    const m = addMonths(`${fromMonth}01`, i).slice(0, 6);
    for (const d of eachDay(`${m}01`, endOfMonth(`${m}01`))) {
      out.push({ date: d, views: typeof viewsPerDay === 'function' ? viewsPerDay(m, d) : viewsPerDay });
    }
  }
  return out;
}

test('month arithmetic clamps instead of overflowing into the next month', () => {
  // Plain setUTCMonth turns 2026-01-31 + 1 month into 2026-03-03.
  assert.equal(addMonths('20260131', 1), '20260228');
  assert.equal(addMonths('20240229', 12), '20250228');
  assert.equal(addMonths('20261231', 2), '20270228');
});

test('analysis windows contain only complete months', () => {
  const w = completeMonthWindow(24);
  assert.equal(w.from.slice(6), '01', 'window starts on the 1st');
  assert.equal(w.to, endOfMonth(w.to), 'window ends on a month end');
  assert.equal(w.to.slice(0, 6), lastCompleteMonth().slice(0, 6));
});

test('--since accepts years, months and days', () => {
  assert.equal(sinceToMonths('2y'), 24);
  assert.equal(sinceToMonths('18m'), 18);
  assert.equal(sinceToMonths('90d'), 3);
  assert.throws(() => sinceToMonths('banana'), /Bad --since/);
});

test('a partial month is flagged incomplete so it cannot skew a comparison', () => {
  // The API returns the CURRENT month as a partial total; treating it as a full
  // month manufactures a decline.
  const series = [
    ...eachDay('20260101', '20260131').map((d) => ({ date: d, views: 10 })),
    ...eachDay('20260201', '20260210').map((d) => ({ date: d, views: 10 })), // 10 of 28 days
  ];
  const m = monthlyRollup(series);
  assert.equal(m.length, 2);
  assert.equal(m[0].complete, true);
  assert.equal(m[1].complete, false);
  assert.equal(m[1].views, 100);
});

test('missing days are counted, not silently treated as zero views', () => {
  const series = eachDay('20260101', '20260131').map((d, i) => ({ date: d, views: i < 3 ? null : 5 }));
  const [m] = monthlyRollup(series);
  assert.equal(m.days_missing, 3);
  assert.equal(m.views, 28 * 5, 'nulls contribute nothing to the total');
  assert.equal(m.days_present, 31);
});

test('two adjacent blocks require enough complete history', () => {
  assert.equal(trailingBlocks(monthlyRollup(daily('202601', 12, 1)), 12), null, '12 months is not enough for 12v12');
  const ok = trailingBlocks(monthlyRollup(daily('202401', 24, 1)), 12);
  assert.equal(ok.recent.length, 12);
  assert.equal(ok.prior.length, 12);
});

test('insufficient history is reported explicitly rather than guessed at', () => {
  const r = compareBlocks(monthlyRollup(daily('202601', 6, 10)), {}, 12);
  assert.equal(r.insufficient_history, true);
  assert.equal(r.months_required, 24);
  assert.equal(r.months_available, 6);
});

test('normalization divides by project totals and can invert the raw verdict', () => {
  // Topic flat at 100/month. Project traffic halves in the recent year, so the
  // topic's SHARE doubles: raw 0%, normalized +100%.
  const monthly = monthlyRollup(daily('202401', 24, (m) => 100 / new Date(Date.UTC(+m.slice(0, 4), +m.slice(4, 6), 0)).getUTCDate()));
  const totals = {};
  for (let i = 0; i < 24; i++) {
    const m = addMonths('20240101', i).slice(0, 6);
    totals[m] = i < 12 ? 1_000_000 : 500_000;
  }
  const r = compareBlocks(monthly, totals, 12);
  assert.ok(Math.abs(r.raw.yoy_pct) < 1e-6, `raw should be flat, got ${r.raw.yoy_pct}`);
  assert.ok(Math.abs(r.normalized.yoy_pct - 100) < 1e-6, `normalized should be +100%, got ${r.normalized.yoy_pct}`);
});

test('normalization is withheld when project totals are incomplete', () => {
  const monthly = monthlyRollup(daily('202401', 24, 10));
  const totals = { 202401: 1000 }; // only one month known
  const r = compareBlocks(monthly, totals, 12);
  assert.equal(r.normalized.unavailable, true);
  assert.ok(r.raw.recent > 0, 'raw figures are still reported');
});

test('median treats gaps as zero but is not dragged around by one spike', () => {
  const s = [...Array(89)].map((_, i) => ({ date: `2026010${i}`, views: 10 }));
  s.push({ date: '20260190', views: 100000 });
  assert.equal(medianDaily(s, 90), 10);
  assert.equal(medianDaily([{ date: 'x', views: null }, { date: 'y', views: null }], 90), 0);
});

test('sparkline shows a cliff, distinguishes gaps from zeros, and survives flat input', () => {
  // The Spanish gold-mining shape: high, then a collapse that never recovers.
  const BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const level = (ch) => BARS.indexOf(ch);
  const cliff = [...sparkline([1982, 1330, 861, 238, 185, 148])];
  assert.equal(cliff.length, 6);
  assert.equal(level(cliff[0]), 7, 'the peak renders as the tallest bar');
  // Bars are anchored at zero, not at the series minimum: 148 of 1982 is 7.5%,
  // so the floor is a low bar rather than the lowest. Anchoring at the minimum
  // would make a flat series look like dramatic movement.
  assert.ok(level(cliff.at(-1)) <= 1, `the collapse bottoms out low, got ${level(cliff.at(-1))}`);
  assert.ok(level(cliff[0]) - level(cliff.at(-1)) >= 5, 'the cliff is visible as a large drop');

  assert.equal(sparkline([5, null, 5]).includes(' '), true, 'a gap is blank, not a zero bar');
  assert.equal(sparkline([0, 0, 0]), '▁▁▁', 'all-zero keeps its length');
  assert.equal(sparkline([]), '');
  assert.equal(monthlySparkline([{ views: 1 }, { views: 2 }]).length, 2);
});

test('cache re-fetches only the missing head, tail and volatile end', () => {
  assert.deepEqual(gapsFor(null, '20240101', '20240201'), [['20240101', '20240201']]);
  assert.deepEqual(gapsFor({ from: '20230101', to: '20240301' }, '20240101', '20240201'), []);
  assert.deepEqual(gapsFor({ from: '20240115', to: '20240301' }, '20240101', '20240201'), [['20240101', '20240114']]);
  assert.deepEqual(gapsFor({ from: '20240115', to: '20240220' }, '20240101', '20240301'), [
    ['20240101', '20240114'],
    ['20240221', '20240301'],
  ]);
});
