# How to develop this further

Ordered by value per unit of work. Each stage is independently shippable and the
evidence for it comes from data this skill already produced.

## 1. Quality gating — the judge  ✅ BUILT

Implemented in `scripts/lib/quality.mjs`; see `references/methodology.md` for the
rubric. What follows is the original case for it, kept because the evidence still
describes what the detectors are for.

v1 reported everything raw. That is a deliberate first step, but three rows from a
single real query should not have been reported as findings:

| observed | why it is not a finding |
|---|---|
| `uk` gold mining, **261 views in a year** (0.7/day) | No trend exists in that much noise |
| `tr` gold mining, **+92% normalized** on 838→1,349 views | One month's spike; one forum post could do it |
| `es` gold mining, **−85%** | A break: 1,982→1,330→861→238 over Mar–Jun 2025, never recovering. Cause unknown — the move log, deletion log and revision history are all empty, and all-agents traffic fell too |

What to add, all computable from series already cached:

- **Volume floor.** Median daily views below a threshold → `insufficient_volume`.
- **Spike detection.** Robust z-score via median absolute deviation on
  `log1p(daily)`. Then recompute year-over-year **excluding** spike days: if the
  sign flips, the growth was one event.
- **Changepoint detection.** CUSUM or a Pettitt test over the monthly series.
  A sustained level shift means an article event, so the trend must not be
  reported as a market signal. This catches the `es` case automatically.
- **Trend significance.** Mann–Kendall with tie correction, plus Sen's slope as
  percent per year. Non-significant trends get labelled as flat.
- **Bot-contamination check.** Compare `agent=user` against `all-agents` over
  time; a rising automated share invalidates a trend.
- **Redirect accounting.** Sum the article's redirects; warn when they carry a
  material share, since a title's count is a lower bound.

Combine these into a **deterministic, documented rubric** producing a
high/medium/low label plus plain-language reasons. Deterministic matters: a
cheap model cannot talk itself into a different confidence level, and the rubric
can be unit-tested against the three cases above as fixtures.

## 2. Concept clusters instead of single articles

A flagship article is a thin proxy. Ukrainian `Астрономія` drew 16,614 views
while eight related astronomy articles drew 258,870 — **the flagship is 6% of
the topic's traffic**, and someone interested in astronomy is reading
`Сонячна система` and `Марс`, not the overview page.

Define a topic as a **set of Wikidata items** (subclass-of / part-of traversal,
or category intersection), then map that set through sitelinks per language.
Three benefits fall out:

- Cross-language comparability improves, because the item set is identical
  everywhere rather than whichever article each language named similarly.
- **Coverage becomes a metric.** If a cluster has 40 items and Polish has
  articles for 12, that is a quantified content gap — a far better answer to the
  intermittent-fasting case than "no article".
- Low-traffic languages get less noisy, because sums are steadier than one thin
  series.

The seam is already in place: `resolve` returns a list of `{qid, title}` per
language and everything downstream aggregates over it, so this is an added layer
rather than a rewrite. Costs 25–50× the requests, which the cache absorbs after
the first run.

## 3. Larger data volumes

Per-article REST calls stop being sensible somewhere around a few hundred
article-language pairs.

- Switch to the **Wikimedia pageview dumps** (hourly/daily bulk files) and load
  them into **DuckDB/Parquet** locally. One column scan then answers questions
  that would be thousands of API calls.
- Incremental daily loads keep it current; the existing cache becomes a hot
  layer in front of the warehouse.
- This is what makes "scan 200 topics across 40 languages" feasible, which in
  turn enables ranking and discovery rather than checking one hypothesis at a
  time.
- With many topic×language cells tested at once, add **multiple-testing
  correction** — otherwise some cell always looks like it is growing.

## 4. Harder research questions

- **Seasonal decomposition** (STL) so education topics can be discussed
  mid-year instead of only in 12-month blocks.
- **Hierarchical / partial pooling** across languages, so a low-volume edition
  borrows strength from the topic's overall behaviour instead of being dismissed.
- **Forecasting with uncertainty bands**, so "growing" becomes "expected range
  next year".
- **Causal impact** around known events, to separate a launch or news cycle from
  an underlying trend.

## 5. Signals beyond pageviews

Pageviews measure curiosity. To get closer to demand:

- **Wikipedia edit activity** — the supply side. Rising reads with flat edits is
  a different situation from both rising together.
- **Clickstream dumps** — referrer paths reveal intent, not just attention.
- **Search volume, app-store data, Reddit/YouTube** — triangulation across
  independent sources is what makes a recommendation defensible.
- **Language→country weighting** using project-level country data plus internet
  population, to convert interest into an addressable audience and partly repair
  the language-is-not-a-market gap.

## 6. Ergonomics for repeated work

- **Saved studies**: name a topic/language/window set, re-run it later, and diff
  against the previous result.
- **Scheduled monitors** that re-check weekly and alert on a trend change or a
  detected changepoint.
- A **shared team cache**, so colleagues do not re-fetch the same series.

## 7. Evaluation flywheel

- Grow `evals/scenarios.jsonl` from real transcripts, especially cases where the
  model chose the wrong command or quoted an unsupported number.
- Golden-file regression tests on `analysis.json` so a statistics change cannot
  silently move published figures.
- Track tokens and cost per scenario. If a change makes the skill more accurate
  but doubles the tokens a cheap model needs, that is a real regression.
