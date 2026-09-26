// Task 4 — deciding whether a figure is safe to report.
//
// The skill can produce numbers that are arithmetically correct and misleading:
// a series whose level breaks partway through, or one so small that its
// percentage is noise. This module detects those and returns a label with its
// reasons, from a fixed deduction table — reproducible and testable rather than
// judged.
//
// Detection runs on the underlying series, never the sparkline: an eight-level
// display glyph puts the peak month at level 7 by definition, and pattern
// matching on it flagged 44% of rows against this rubric's 5%.
//
// The detectors find breaks; they do not explain them. `verifyChangepoint` in
// views.mjs queries Wikipedia's logs for that.

// ---------------------------------------------------------------------------
// Derived constants
// ---------------------------------------------------------------------------

/**
 * Φ⁻¹(0.75) = 0.6745 — the 75th percentile of the standard normal.
 *
 * For normally distributed data MAD ≈ 0.6745·σ, so multiplying by it converts a
 * MAD-based deviation back into standard-deviation units. That makes
 * `0.6745·(x − median)/MAD` the *modified z-score* (Iglewicz & Hoaglin, 1993):
 * read like an ordinary z-score, but computed from medians.
 */
const MAD_TO_SIGMA = 0.6745;

/**
 * Outlier cut-off for that score, as recommended by Iglewicz & Hoaglin. Under
 * normality it is about 0.05% of observations — one day in 2,000 — so on a
 * 730-day window a hit is genuinely rare. Dropping it to 3.0 roughly triples
 * the flag rate.
 */
const SPIKE_Z = 3.5;

// ---------------------------------------------------------------------------
// Tuned thresholds — calibrated against observed articles, not derived.
// Each exists because a real series defeated the version without it. Changing
// one changes which rows get flagged; tests/quality.test.mjs pins the behaviour.
// ---------------------------------------------------------------------------

/** Spikes are rare by definition. Past this share of days the series is merely dispersed. */
const SPIKE_MAX_DAY_SHARE = 0.05;

/** A month this far above the median is an event whatever its z-score (tr: 424 vs 72 = 5.9x, z only 3.3). */
const MONTH_SPIKE_RATIO = 4;

/** More flagged months than this is a level change, not spikes (a break's pre-period flagged 7). */
const MONTH_SPIKE_MAX = 3;

/** Below this monthly volume a ratio means nothing: 26 → 12 views scored a "2.1x break". */
const CP_MIN_LEVEL = 100;

/** A break must be large. Sits below the smallest real break seen (8.3x) and above ordinary decline. */
const CP_MIN_RATIO = 1.8;

/** …and abrupt: at least this share of the window's total change must land at the split. */
const CP_MIN_ABRUPTNESS = 0.6;

/** Months required either side of a candidate split, so an edge cannot masquerade as a break. */
const CP_MIN_SEGMENT = 4;

/** Months averaged either side of the split to size the jump. */
const CP_WINDOW = 3;

/** Score thresholds for the label. */
export const LABELS = { high: 0.7, medium: 0.4 };

const YEAR = 365;

// ---------------------------------------------------------------------------

/**
 * Median, not mean, throughout — and MAD, not standard deviation. The mean and
 * sd are themselves dragged by the outliers being hunted: one 50,000-view day
 * inflates sd enough to hide itself. The median's breakdown point is 50%, the
 * mean's is 0%.
 */
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Pageview traffic is multiplicative and right-skewed, so variation is
 * proportional: 1 → 10 on a quiet article and 1,000 → 10,000 on a busy one are
 * the same event, but on a raw scale the second dwarfs the first. Logs make
 * them comparable. `log1p` rather than `log` so zero-view days do not give −∞.
 */
const logv = (v) => Math.log1p(Math.max(0, v ?? 0));

const madOf = (vals, med) => median(vals.map((v) => Math.abs(v - med)));
const zScore = (v, med, mad) => (MAD_TO_SIGMA * (v - med)) / mad;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/** Days whose volume is extreme relative to the series' own spread. */
export function detectSpikes(series, { threshold = SPIKE_Z, minRatio = MONTH_SPIKE_RATIO } = {}) {
  const empty = { days: [], count: 0, share_of_views: 0, threshold };
  if (!series.length) return empty;

  const vals = series.map((p) => logv(p.views));
  const med = median(vals);
  const mad = madOf(vals, med);
  const medViews = median(series.map((p) => p.views ?? 0));

  // A near-constant series has MAD 0, leaving the z-score undefined. Fall back
  // to a ratio — but only where the median is big enough to take one: at a
  // median of 0, every day with a single view scored as a spike (308 of them).
  const useRatio = mad === 0;
  if (useRatio && medViews < 1) return empty;

  const days = [];
  let spikeViews = 0;
  let totalViews = 0;
  series.forEach((p, i) => {
    const v = p.views ?? 0;
    totalViews += v;
    const z = useRatio ? null : zScore(vals[i], med, mad);
    const hit = useRatio ? v >= Math.max(minRatio * medViews, medViews + 1) : z > threshold;
    if (hit) {
      days.push({ date: p.date, views: v, ...(z != null && { z: +z.toFixed(1) }) });
      spikeViews += v;
    }
  });

  if (days.length > Math.max(5, Math.round(series.length * SPIKE_MAX_DAY_SHARE))) return empty;
  return {
    days,
    count: days.length,
    share_of_views: totalViews ? +(spikeViews / totalViews).toFixed(3) : 0,
    threshold,
  };
}

/**
 * A permanent level shift. After one, the two halves of the window are not
 * comparable, whatever caused it.
 *
 * The difficulty is that a steadily declining series also has a "best split", so
 * three conditions must hold together — large, abrupt, and severed. Each was
 * added because a real article defeated the version without it.
 */
export function detectChangepoint(
  monthly,
  { minSegment = CP_MIN_SEGMENT, minRatio = CP_MIN_RATIO, minShare = CP_MIN_ABRUPTNESS, minLevel = CP_MIN_LEVEL } = {},
) {
  const rows = monthly.filter((m) => m.complete);
  if (rows.length < 2 * minSegment + 2) return null;
  if (Math.max(...rows.map((m) => m.views)) < minLevel) return null; // uk: 26 → 12 views/month

  const logs = rows.map((m) => logv(m.views));
  let best = null;
  for (let k = minSegment; k <= logs.length - minSegment; k++) {
    const diff = mean(logs.slice(0, k)) - mean(logs.slice(k));
    if (!best || Math.abs(diff) > Math.abs(best.diff)) best = { k, diff };
  }
  if (!best) return null;

  // Segment levels use medians: a spike beside the split otherwise inflates the
  // level it falls in and manufactures a step (en "Electric car", 42,007 views).
  const { k } = best;
  const w = CP_WINDOW;
  const localJump = median(logs.slice(Math.max(0, k - w), k)) - median(logs.slice(k, k + w));
  const totalChange = median(logs.slice(0, w)) - median(logs.slice(-w));

  const share = totalChange === 0 ? 0 : localJump / totalChange; // abrupt, not gradual
  const ratio = Math.exp(Math.abs(localJump)); // exp() because the jump is in log space
  if (!(share >= minShare && ratio >= minRatio)) return null;

  // Severed: no month after the split reaches any month before it. A decline
  // that recovers keeps overlapping — fr "Voiture électrique" climbs back to
  // 2,788 against a pre-period low of 2,672.
  const pre = rows.slice(0, k).map((m) => m.views);
  const post = rows.slice(k).map((m) => m.views);
  const severed = localJump > 0 ? Math.max(...post) < Math.min(...pre) : Math.min(...post) > Math.max(...pre);
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
 * A single month far above the rest. Daily MAD misses this: a bump spread over
 * thirty days is not an extreme day, just a month of raised traffic.
 */
export function detectMonthlySpike(
  monthly,
  { threshold = SPIKE_Z, minRatio = MONTH_SPIKE_RATIO, maxMonths = MONTH_SPIKE_MAX } = {},
) {
  const rows = monthly.filter((m) => m.complete);
  if (rows.length < 6) return null;

  const vals = rows.map((m) => logv(m.views));
  const med = median(vals);
  const mad = madOf(vals, med);
  if (mad === 0) return null;
  const medViews = median(rows.map((m) => m.views));

  const total = sum(rows.map((m) => m.views));
  const hits = rows
    .map((m, i) => ({ month: m.month, views: m.views, z: +zScore(vals[i], med, mad).toFixed(1) }))
    .filter((h) => h.z > threshold || (medViews > 0 && h.views >= minRatio * medViews));

  // Many flagged months means the level changed and the median now sits at the
  // new floor, making everything before it look extreme. That is the
  // changepoint rule's job, not this one's.
  if (!hits.length || hits.length > maxMonths) return null;
  const share = total ? sum(hits.map((h) => h.views)) / total : 0;
  return { months: hits, count: hits.length, share_of_views: +share.toFixed(3) };
}

/**
 * Recompute year-over-year with spike days replaced by the median. If removing
 * a handful of days flips the sign, the "trend" was an event.
 */
export function spikeSensitivity(series, spikeDates, n = YEAR) {
  if (!spikeDates.size || series.length < 2 * n) return null;
  const kept = series.filter((p) => !spikeDates.has(p.date)).map((p) => p.views ?? 0);
  if (!kept.length) return null;
  const fill = median(kept);
  const filled = series.map((p) => (spikeDates.has(p.date) ? fill : (p.views ?? 0)));

  const prior = sum(filled.slice(-2 * n, -n));
  if (prior <= 0) return null;
  return +((sum(filled.slice(-n)) / prior - 1) * 100).toFixed(1);
}

/**
 * Deduction table. Costs express how much each problem should discount a
 * figure; `disqualifying` marks the two that are categorical rather than
 * matters of degree, and force `low` at any score.
 */
const RULES = [
  {
    id: 'no_signal',
    cost: 0.5,
    disqualifying: true, // no traffic means there is no trend to measure
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
    disqualifying: true, // the series stopped measuring one consistent thing
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

/** Assess one language's series: a label, a score, and the reason for every deduction. */
export function assess({ series, monthly, comparison, medianDaily, changepointNote }) {
  const spikes = detectSpikes(series);
  const changepoint = detectChangepoint(monthly);
  if (changepoint && changepointNote) changepoint.log_check = changepointNote;
  const monthlySpike = detectMonthlySpike(monthly);
  const spikeDates = new Set(spikes.days.map((d) => d.date));

  const signals = {
    median_daily: medianDaily,
    months_available: monthly.filter((m) => m.complete).length,
    days_missing_share: series.length ? series.filter((p) => p.views === null).length / series.length : 0,
    spike_days: spikes.count,
    spike_share: spikes.share_of_views,
    changepoint,
    monthly_spike: monthlySpike,
    yoy_pct: comparison?.raw?.yoy_pct ?? null,
    yoy_excl_spikes: spikeSensitivity(series, spikeDates),
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

  return {
    confidence: disqualified ? 'low' : score >= LABELS.high ? 'high' : score >= LABELS.medium ? 'medium' : 'low',
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
      ...(signals.yoy_excl_spikes != null && { yoy_excl_spikes: signals.yoy_excl_spikes }),
    },
  };
}
