// Task 4 — deciding whether a number is safe to report.
//
// The skill can produce figures that are arithmetically correct and misleading.
// Spanish "gold mining" fell 80.5% because its traffic collapsed 8x over four
// months and never came back; the two halves of that window are not comparable,
// whatever caused the break. Ukrainian drew 261 views in a year, so its
// percentage is noise with a decimal point. Turkish grew 92% on one month.
//
// Note what is NOT claimed. An earlier version of this file asserted the Spanish
// article had been renamed. Checking the move log, the deletion log and the
// revision history found nothing: no move, no edits during the collapse, and
// all-agents traffic fell alongside agent=user, so it was not a bot
// reclassification either. The detector sees a level shift; the cause is a
// separate question, and `verifyChangepoint` in views.mjs goes and asks it.
//
// Everything here works on the UNDERLYING SERIES, never on the sparkline. An
// eight-level display glyph puts the peak month at level 7 by definition, so
// pattern-matching on it flags roughly a third of all rows — a detector that
// cries wolf that often is worse than none.
//
// The verdict is a deterministic rubric rather than model judgement, so it can
// be unit-tested against known cases and cannot be argued with by an agent.

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const log1p = (v) => Math.log1p(Math.max(0, v ?? 0));

/**
 * Days whose volume is extreme relative to the series' own spread.
 *
 * Median absolute deviation on log1p(views): robust to the very outliers it is
 * looking for, and the log keeps a busy article's normal variation from
 * swamping a quiet one's. 3.5 is the conventional cut-off for the MAD-based
 * z-score.
 */
export function detectSpikes(series, { threshold = 3.5, minRatio = 4 } = {}) {
  if (!series.length) return { days: [], count: 0, share_of_views: 0, threshold };
  const vals = series.map((p) => log1p(p.views));
  const med = median(vals);
  const mad = median(vals.map((v) => Math.abs(v - med)));
  const medViews = median(series.map((p) => p.views ?? 0));

  // A near-constant series has MAD 0, which made the z-score undefined and
  // suppressed detection entirely: 199 days at 100 plus one at 50,000 found
  // nothing. Real traffic is never that flat, so this only ever showed up under
  // test -- but the same degeneracy bites whenever most days share a value.
  // The ratio fallback needs a median worth taking a ratio of. Ukrainian "gold
  // mining" sits at 0 views/day, which made every day with a single view a
  // "spike" -- 308 of them. Volume rules already cover that series.
  const useRatio = mad === 0 && medViews >= 1;
  if (mad === 0 && medViews < 1) return { days: [], count: 0, share_of_views: 0, threshold };

  const days = [];
  let spikeViews = 0;
  let totalViews = 0;
  series.forEach((p, i) => {
    const v = p.views ?? 0;
    totalViews += v;
    const z = useRatio ? null : (0.6745 * (vals[i] - med)) / mad;
    const hit = useRatio ? medViews >= 0 && v >= Math.max(minRatio * medViews, medViews + 1) : z > threshold;
    if (hit) {
      days.push({ date: p.date, views: v, ...(z != null && { z: +z.toFixed(1) }) });
      spikeViews += v;
    }
  });
  // Rare by definition. When a large share of days flag, the series is simply
  // dispersed rather than spiky, and calling it out would be noise.
  const maxDays = Math.max(5, Math.round(series.length * 0.05));
  if (days.length > maxDays) return { days: [], count: 0, share_of_views: 0, threshold };

  return {
    days,
    count: days.length,
    share_of_views: totalViews ? +(spikeViews / totalViews).toFixed(3) : 0,
    threshold,
  };
}

/**
 * A sustained level shift, which means an article event rather than a market
 * one: a rename, a merge, or redirects being repointed.
 *
 * The hard part is not finding the biggest split — a steadily declining series
 * has one too. It is separating ABRUPT from GRADUAL. So the test asks how much
 * of the window's total change happens across the three months either side of
 * the split. A rename dumps nearly all of it there; a genuine decline spreads
 * it out.
 */
export function detectChangepoint(monthly, { minSegment = 4, minRatio = 1.8, minShare = 0.6, minLevel = 100 } = {}) {
  const rows = monthly.filter((m) => m.complete);
  if (rows.length < 2 * minSegment + 2) return null;
  // A "5x drop" from 26 views/month to 12 is noise, not a rename. Ratios on
  // tiny counts are meaningless, so the detector only runs where there is
  // enough traffic for a level shift to mean something.
  if (Math.max(...rows.map((m) => m.views)) < minLevel) return null;

  const logs = rows.map((m) => log1p(m.views));
  let best = null;
  for (let k = minSegment; k <= logs.length - minSegment; k++) {
    const diff = mean(logs.slice(0, k)) - mean(logs.slice(k));
    if (!best || Math.abs(diff) > Math.abs(best.diff)) best = { k, diff };
  }
  if (!best) return null;

  // Segment levels use the MEDIAN, not the mean. A spike month adjacent to the
  // split otherwise inflates the level it falls in and manufactures a step:
  // English "Electric car" has a 42,007 month next to a genuine gradual decline,
  // which a mean read as a 2x drop. The median ignores it, and the real ratio
  // (1.67) falls below the threshold as it should.
  const { k } = best;
  const w = 3;
  const localJump = median(logs.slice(Math.max(0, k - w), k)) - median(logs.slice(k, k + w));
  const totalChange = median(logs.slice(0, w)) - median(logs.slice(-w));

  // Nearly all of the move concentrated at one point, and a big move at that.
  const share = totalChange === 0 ? 0 : localJump / totalChange;
  const ratio = Math.exp(Math.abs(localJump));
  if (!(share >= minShare && ratio >= minRatio)) return null;

  // A rename severs the traffic permanently: no month afterwards reaches any
  // month before. A gradual decline keeps overlapping. French "Voiture
  // electrique" drops then climbs back to 2,788 against a pre-period low of
  // 2,672 -- that is a decline with noise, not a step -- while Spanish "Mineria
  // del oro" peaks at 439 afterwards against a pre-period low of 861.
  const pre = rows.slice(0, k).map((m) => m.views);
  const post = rows.slice(k).map((m) => m.views);
  const severed =
    localJump > 0 ? Math.max(...post) < Math.min(...pre) : Math.min(...post) > Math.max(...pre);
  if (!severed) return null;

  return {
    month: rows[k].month,
    direction: localJump > 0 ? 'drop' : 'rise',
    ratio: +ratio.toFixed(1),
    share_of_total_change: +share.toFixed(2),
    before: Math.round(Math.expm1(median(logs.slice(Math.max(0, k - w), k)))),
    after: Math.round(Math.expm1(median(logs.slice(k, k + w)))),
  };
}

/**
 * A single month far above the rest.
 *
 * Daily MAD misses this: a bump spread over thirty days is not an extreme day,
 * it is a month of moderately raised traffic. Turkish "gold mining" grew 92% on
 * exactly that shape and showed no spike days at all.
 */
export function detectMonthlySpike(monthly, { threshold = 3.5, minRatio = 4, maxMonths = 3 } = {}) {
  const rows = monthly.filter((m) => m.complete);
  if (rows.length < 6) return null;
  const vals = rows.map((m) => log1p(m.views));
  const med = median(vals);
  const mad = median(vals.map((v) => Math.abs(v - med)));
  if (mad === 0) return null;
  const medViews = median(rows.map((m) => m.views));

  // Two ways in. The z-score catches months that are extreme relative to the
  // series' own spread; the ratio catches obvious events the z-score just
  // misses. Turkish "gold mining" peaked at 424 against a median of 72 -- a
  // 5.9x event -- and scored z = 3.3, fractionally under the cut-off.
  const total = rows.reduce((a, m) => a + m.views, 0);
  const hits = rows
    .map((m, i) => ({ month: m.month, views: m.views, z: +((0.6745 * (vals[i] - med)) / mad).toFixed(1) }))
    .filter((h) => h.z > threshold || (medViews > 0 && h.views >= minRatio * medViews));
  // A spike is rare by definition. When many months flag, the series has changed
  // LEVEL and the median now sits at the new floor, so everything before it
  // looks extreme: Spanish "gold mining" flagged the seven months preceding its
  // rename, which is a step, not an event. The changepoint rule covers that case.
  if (!hits.length || hits.length > maxMonths) return null;
  const share = total ? hits.reduce((a, h) => a + h.views, 0) / total : 0;
  return { months: hits, count: hits.length, share_of_views: +share.toFixed(3) };
}

/**
 * Recompute year-over-year with spike days neutralised.
 * If removing a handful of days flips the sign, the "trend" was an event.
 */
export function spikeSensitivity(series, spikeDates, n = 365) {
  if (!spikeDates.size) return null;
  const clean = series.map((p) => (spikeDates.has(p.date) ? null : p.views));
  const known = clean.filter((v) => v !== null);
  if (!known.length) return null;
  const fill = median(known);
  const filled = clean.map((v) => (v === null ? fill : (v ?? 0)));

  if (filled.length < 2 * n) return null;
  const prior = filled.slice(-2 * n, -n).reduce((a, b) => a + b, 0);
  const recent = filled.slice(-n).reduce((a, b) => a + b, 0);
  if (prior <= 0) return null;
  return +(((recent / prior) - 1) * 100).toFixed(1);
}

/** Deduction table. Every entry states what it costs and why, so the score is auditable. */
const RULES = [
  {
    id: 'no_signal',
    cost: 0.5,
    disqualifying: true, // no amount of other quality rescues a series with no traffic
    test: (s) => s.median_daily < 1,
    why: (s) => `median ${s.median_daily} views/day — too little traffic for any trend to exist`,
  },
  {
    id: 'very_low_volume',
    cost: 0.35,
    test: (s) => s.median_daily >= 1 && s.median_daily < 10,
    why: (s) => `median ${s.median_daily} views/day — a percentage on this much traffic is mostly noise`,
  },
  {
    id: 'low_volume',
    cost: 0.15,
    test: (s) => s.median_daily >= 10 && s.median_daily < 50,
    why: (s) => `median ${s.median_daily} views/day — small enough that single events move the figure`,
  },
  {
    id: 'changepoint',
    cost: 0.35,
    disqualifying: true, // the series stops measuring one consistent thing
    test: (s) => Boolean(s.changepoint),
    why: (s) =>
      `level ${s.changepoint.direction} of ${s.changepoint.ratio}x at ${s.changepoint.month} ` +
      `(${s.changepoint.before} to ${s.changepoint.after}/month) with no recovery — the series is not measuring ` +
      `the same thing throughout, so the period comparison is not meaningful` +
      (s.changepoint.log_check ? `. ${s.changepoint.log_check}` : ''),
  },
  {
    id: 'spike_sign_flip',
    cost: 0.3,
    test: (s) => s.yoy_excl_spikes != null && s.yoy_pct != null && Math.sign(s.yoy_excl_spikes) !== Math.sign(s.yoy_pct),
    why: (s) => `${s.yoy_pct}% becomes ${s.yoy_excl_spikes}% once spike days are removed — the direction comes from a few days`,
  },
  {
    id: 'monthly_spike',
    cost: 0.25,
    test: (s) => Boolean(s.monthly_spike),
    why: (s) =>
      `${s.monthly_spike.count} month(s) far above the rest carry ${Math.round(s.monthly_spike.share_of_views * 100)}% of all views ` +
      `(${s.monthly_spike.months.map((m) => m.month).join(', ')}) — one event, not a trend`,
  },
  {
    id: 'spike_heavy',
    cost: 0.2,
    test: (s) => s.spike_share > 0.2,
    why: (s) => `${Math.round(s.spike_share * 100)}% of all views fall on ${s.spike_days} spike day(s)`,
  },
  {
    id: 'sparse',
    cost: 0.15,
    test: (s) => s.days_missing_share > 0.1,
    why: (s) => `${Math.round(s.days_missing_share * 100)}% of days have no data upstream and are counted as zero`,
  },
  {
    id: 'short_history',
    cost: 0.2,
    test: (s) => s.months_available < 24,
    why: (s) => `only ${s.months_available} complete months available`,
  },
];

export const LABELS = { high: 0.7, medium: 0.4 };

/**
 * Assess one language's series. Returns a label, a score, and the reasons
 * behind every deduction.
 */
export function assess({ series, monthly, comparison, medianDaily, changepointNote }) {
  const spikes = detectSpikes(series);
  const changepoint = detectChangepoint(monthly);
  if (changepoint && changepointNote) changepoint.log_check = changepointNote;
  const monthlySpike = detectMonthlySpike(monthly);
  const spikeDates = new Set(spikes.days.map((d) => d.date));
  const yoyExcl = spikeSensitivity(series, spikeDates);

  const signals = {
    median_daily: medianDaily,
    months_available: monthly.filter((m) => m.complete).length,
    days_missing_share: series.length ? series.filter((p) => p.views === null).length / series.length : 0,
    spike_days: spikes.count ?? 0,
    spike_share: spikes.share_of_views,
    changepoint,
    monthly_spike: monthlySpike,
    yoy_pct: comparison?.raw?.yoy_pct ?? null,
    yoy_excl_spikes: yoyExcl,
  };

  let score = 1;
  let disqualified = false;
  const reasons = [];
  for (const rule of RULES) {
    if (!rule.test(signals)) continue;
    score -= rule.cost;
    if (rule.disqualifying) disqualified = true;
    reasons.push({ id: rule.id, cost: rule.cost, detail: rule.why(signals) });
  }
  score = Math.max(0, +score.toFixed(2));
  // Some findings are not a matter of degree. A detected level shift means the
  // series is no longer measuring one consistent thing, so no amount of volume
  // makes the percentage safe to quote.
  const label = disqualified ? 'low' : score >= LABELS.high ? 'high' : score >= LABELS.medium ? 'medium' : 'low';

  return {
    confidence: label,
    score,
    reasons,
    signals: {
      median_daily: signals.median_daily,
      months_available: signals.months_available,
      days_missing_share: +signals.days_missing_share.toFixed(3),
      spike_days: signals.spike_days,
      spike_share: signals.spike_share,
      ...(changepoint && { changepoint }),
      ...(monthlySpike && { monthly_spike: monthlySpike }),
      ...(yoyExcl != null && { yoy_excl_spikes: yoyExcl }),
    },
  };
}
