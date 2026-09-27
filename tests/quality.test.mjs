// Quality rubric. Synthetic series, so the ground truth is known exactly.
//
// The detectors exist to separate three failure modes from healthy data, and
// the expensive mistake is a FALSE POSITIVE on the disqualifying rule: wrongly
// calling a genuine decline a rename suppresses a real finding. Most of these
// cases guard that direction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSpikes, detectChangepoint, detectMonthlySpike, spikeSensitivity, assess } from '../scripts/lib/quality.mjs';

const daily = (views) => views.map((v, i) => ({ date: `2024${String(i).padStart(4, '0')}`, views: v }));
const monthly = (views, startYm = 202409) =>
  views.map((v, i) => {
    const y = Math.floor(startYm / 100) + Math.floor(((startYm % 100) - 1 + i) / 12);
    const m = (((startYm % 100) - 1 + i) % 12) + 1;
    return { month: `${y}${String(m).padStart(2, '0')}`, views: v, complete: true, days_missing: 0 };
  });

test('spike detection finds an extreme day and ignores ordinary variation', () => {
  const noisy = daily(Array.from({ length: 200 }, (_, i) => 100 + (i % 7) * 5));
  assert.equal(detectSpikes(noisy).days.length, 0, 'routine variation is not a spike');

  const withSpike = daily([...Array(199).fill(100), 50_000]);
  const found = detectSpikes(withSpike);
  assert.equal(found.days.length, 1);
  assert.equal(found.days[0].views, 50_000);
});

test('a flat series produces no spikes rather than dividing by zero', () => {
  assert.deepEqual(detectSpikes(daily(Array(100).fill(42))).days, []);
  assert.deepEqual(detectSpikes([]).days, []);
});

test('a real rename is detected: the level drops and never recovers', () => {
  // Spanish "Mineria del oro", the actual monthly series.
  const es = monthly([2300, 2589, 2507, 2468, 2007, 2371, 1982, 1330, 861, 238, 185, 148,
                      110, 148, 142, 106, 163, 138, 238, 439, 407, 388, 276, 372]);
  const cp = detectChangepoint(es);
  assert.ok(cp, 'must fire');
  assert.equal(cp.direction, 'drop');
  assert.ok(cp.ratio >= 4, `expected a large ratio, got ${cp.ratio}`);
});

test('a gradual decline is NOT called a rename', () => {
  // Steady ~4%/month decay: the expensive false positive to avoid.
  const gradual = monthly(Array.from({ length: 24 }, (_, i) => Math.round(4000 * 0.96 ** i)));
  assert.equal(detectChangepoint(gradual), null);
});

test('a decline that recovers is NOT a rename, because the segments overlap', () => {
  // French "Voiture electrique": drops, then climbs back above the pre-period low.
  const fr = monthly([2672, 4537, 4465, 3997, 3928, 3400, 3858, 3158, 2483, 1828, 1668, 1592,
                      2069, 2788, 2561, 2076, 2041, 1996, 2403, 2451, 2207, 1876, 1754, 1577]);
  assert.equal(detectChangepoint(fr), null, 'post-period reaches 2788 vs a pre-period low of 2672');
});

test('a spike next to a split does not manufacture a changepoint', () => {
  // English "Electric car": one 42,007 month beside an ordinary decline. Mean-based
  // segment levels read this as a 2x step; medians do not.
  const en = monthly([17582, 19195, 19456, 18935, 24292, 20174, 42007, 14945, 14509, 12220, 11020, 13164,
                      12208, 11859, 12321, 11395, 10965, 9733, 12272, 12543, 13977, 11393, 10152, 10923]);
  assert.equal(detectChangepoint(en), null);
});

test('changepoint does not run on traffic too small for a ratio to mean anything', () => {
  // 26 -> 12 views/month is noise, not an article event.
  const tiny = monthly([26, 24, 28, 30, 25, 27, 26, 12, 11, 13, 10, 12, 11, 12, 10, 11, 13, 12, 11, 10, 12, 11, 13, 12]);
  assert.equal(detectChangepoint(tiny), null);
});

test('a single outlier month is a spike; a whole shifted level is not', () => {
  // Turkish "Altin madenciligi": one 424 month against a median near 72.
  const tr = monthly([24, 40, 104, 71, 70, 102, 87, 83, 72, 39, 61, 85, 424, 210, 117, 101, 90, 67, 36, 54, 45, 35, 44, 126]);
  const spike = detectMonthlySpike(tr);
  assert.ok(spike, 'must fire');
  assert.ok(spike.months.some((m) => m.views === 424));

  // The seven months preceding a rename are a step, not seven spikes.
  const stepped = monthly([2000, 2100, 2050, 1980, 2200, 2000, 1900, 200, 190, 210, 180, 200,
                           195, 205, 190, 200, 185, 210, 195, 200, 190, 205, 195, 200]);
  assert.equal(detectMonthlySpike(stepped), null, 'more than 3 flagged months means a level change');
});

test('removing spike days can flip the year-over-year sign', () => {
  const flat = Array(730).fill(10);
  const withBurst = [...flat];
  for (let i = 400; i < 410; i++) withBurst[i] = 5000; // a burst inside the recent year
  const series = daily(withBurst);
  const dates = new Set(detectSpikes(series).days.map((d) => d.date));
  assert.ok(dates.size > 0);
  const cleaned = spikeSensitivity(series, dates);
  assert.ok(Math.abs(cleaned) < 1, `without the burst the series is flat, got ${cleaned}%`);
});

test('the rubric scores healthy data high and states no reasons', () => {
  const series = daily(Array.from({ length: 730 }, () => 500));
  const m = monthly(Array(24).fill(15_000));
  const q = assess({ series, monthly: m, comparison: { raw: { yoy_pct: -5 } }, medianDaily: 500 });
  assert.equal(q.confidence, 'high');
  assert.equal(q.score, 1);
  assert.deepEqual(q.reasons, []);
});

// es "gold mining": 1,982 -> 238/month over four months, never recovering.
const ES_GOLD = [2300, 2589, 2507, 2468, 2007, 2371, 1982, 1330, 861, 238, 185, 148,
                 110, 148, 142, 106, 163, 138, 238, 439, 407, 388, 276, 372];

test('a detected level shift is disqualifying regardless of the score', () => {
  const series = daily(Array.from({ length: 730 }, () => 40));
  const q = assess({ series, monthly: monthly(ES_GOLD), comparison: { raw: { yoy_pct: -84.6 } }, medianDaily: 40 });
  assert.equal(q.confidence, 'low', 'a level shift means the series stopped measuring one thing');
  assert.ok(q.reasons.some((r) => r.id === 'changepoint_unexplained'));
});

test('a break with a move log and a break without one are told apart', () => {
  // Both disqualify the percentage. They must not say the same thing: one is an
  // artifact of the article, the other is a real collapse nobody can explain, and
  // a founder reading the report needs to know which.
  const series = daily(Array.from({ length: 730 }, () => 40));
  const base = { series, monthly: monthly(ES_GOLD), comparison: { raw: { yoy_pct: -84.6 } }, medianDaily: 40 };

  const renamed = assess({
    ...base,
    changepointCheck: { cause: 'article_event', detail: 'Wikipedia logs show 2 event(s) around then (move/move), which explains the break as an article event' },
  });
  const r1 = renamed.reasons.find((r) => r.id === 'changepoint_article_event');
  assert.ok(r1, 'a logged move must select the article-event rule');
  assert.match(r1.detail, /Wikipedia logs show/);
  assert.match(r1.detail, /moved or merged, so this is not a change in interest/);
  assert.equal(renamed.confidence, 'low');

  const unexplained = assess({
    ...base,
    changepointCheck: { cause: 'no_activity', detail: 'No move, deletion or edit activity around that month, so the break is not an article-side change' },
  });
  const r2 = unexplained.reasons.find((r) => r.id === 'changepoint_unexplained');
  assert.ok(r2, 'no logged activity must select the unexplained rule');
  assert.match(r2.detail, /report the shift and its date/);
  assert.ok(!/moved or merged/.test(r2.detail), 'must not call an unexplained drop a rename');
  assert.equal(unexplained.confidence, 'low');
});

test('an unverified break says only what is known', () => {
  // The log check is one network request and may not have run at all.
  const series = daily(Array.from({ length: 730 }, () => 40));
  const q = assess({ series, monthly: monthly(ES_GOLD), comparison: { raw: { yoy_pct: -84.6 } }, medianDaily: 40 });
  const r = q.reasons.find((x) => x.id === 'changepoint_unexplained');
  assert.match(r.detail, /not measuring the same thing throughout/);
  assert.ok(!/logged|activity/.test(r.detail), 'with no verdict it must not claim anything about the logs');
});

test('too little traffic is low confidence on its own', () => {
  const series = daily(Array.from({ length: 730 }, () => 0));
  const m = monthly(Array(24).fill(12));
  const q = assess({ series, monthly: m, comparison: { raw: { yoy_pct: -36 } }, medianDaily: 0 });
  assert.equal(q.confidence, 'low');
  assert.ok(q.reasons.some((r) => r.id === 'no_signal'));
});

test('every reason carries a cost and a human-readable detail', () => {
  const series = daily(Array.from({ length: 730 }, () => 2));
  const m = monthly(Array(24).fill(60));
  const q = assess({ series, monthly: m, comparison: { raw: { yoy_pct: 10 } }, medianDaily: 2 });
  assert.ok(q.reasons.length > 0);
  for (const r of q.reasons) {
    assert.ok(r.id && typeof r.cost === 'number' && r.detail.length > 20, JSON.stringify(r));
  }
});
