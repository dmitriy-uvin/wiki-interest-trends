# How each figure is computed

Exact definitions, so a number can be checked or disputed.

## Window

`--since` is converted to a whole number of months (`2y` → 24, `90d` → 3). The
window is the last *n* **complete** months, ending with the last complete
calendar month. It never includes the month in progress.

Month arithmetic clamps rather than overflows: 2026-01-31 minus one month is
2025-12-31, not a date in early January.

## Resolution

1. Look up the topic phrase as an exact title on the `--from` edition, following
   redirects. If it exists and is not a disambiguation page, take its Wikidata id.
2. Otherwise full-text search that edition and take the first non-disambiguation
   hit. Other candidates are returned in `other_candidates`.
3. Otherwise search Wikidata entities directly.

Then fetch **sitelinks** for that Wikidata item, filtered to the requested
languages. Sitelinks, not langlinks: langlinks can point at article sections,
which cannot be measured.

Each title is then verified on its own wiki, following redirects, which yields
the canonical title, the page size, a disambiguation flag, and the target's
Wikidata id.

**Fold test.** If a sitelink redirects to a page whose Wikidata id differs from
the topic's, the concept has been folded into a broader article. It is reported
as `folded_into_broader_article` rather than measured, unless `--allow-fold` is
given. Equal ids mean a simple rename, which is measured normally.

## Series

`GET /metrics/pageviews/per-article/{project}/all-access/user/{title}/daily/{from}/{to}`

`agent=user` excludes bots. `access=all-access` combines desktop and mobile.

The response is reindexed onto every calendar day in the window. Days the API
did not return become `null` and are counted in `days_missing`. Sums treat
`null` as zero; `days_missing` is reported so a sparse series is not mistaken
for a dense one.

## Monthly rollup

Daily points are grouped by calendar month. A month is `complete` when the
number of days present equals the number of days in that month. Only complete
months feed any comparison.

## Normalization

`GET /metrics/pageviews/aggregate/{project}/all-access/user/monthly/{from}/{to}`
gives total human pageviews for the whole edition.

```
per_million(month) = topic_views(month) / project_views(month) * 1_000_000
```

A month is dropped from **both** numerator and denominator if either side is
missing, so the two always cover the same span. If any month in either block
lacks project totals, normalized figures are withheld entirely and reported as
`unavailable` rather than being computed from a partial span.

## Year-over-year

With a 24-month window, the recent 12 complete months are compared against the
12 before them.

```
yoy_pct = (sum(recent) / sum(prior) - 1) * 100
```

Applied to raw views for `raw.yoy_pct`, and to per-million shares for
`normalized.yoy_pct`. Twelve-month blocks are used rather than month-on-month
because they are seasonality-robust by construction: each block contains every
calendar month exactly once.

If fewer than 2×12 complete months exist, `insufficient_history` is returned
with what is available. No comparison is fabricated from a shorter span.

## Level

`median_daily_90d` is the median of the last 90 daily values, with `null`
treated as zero. The median rather than the mean, so a single viral day does not
define the level.

## Sparkline

Monthly totals rendered as eight block glyphs, scaled against the series maximum
and **anchored at zero**. Anchoring at the series minimum would make a flat line
look dramatic. Gaps render as a space; an all-zero series renders as the lowest
bar rather than collapsing to nothing.

In the PDF the same shape is drawn as vector rectangles, because the embedded
Noto Sans has no block-element glyphs.

## Chart

Each language's per-million series is indexed to 100 at its first month with
data, so editions three orders of magnitude apart share one axis. The dashed
line marks the 100 baseline. Gaps break the line rather than being interpolated.

## Confidence

A deterministic rubric over the underlying series. Every row starts at 1.0 and
loses points; the label is `high` at 0.7+, `medium` at 0.4+, `low` below.

| deduction | cost | fires when |
|---|---|---|
| `no_signal` | 0.5 | median < 1 view/day. **Disqualifying.** |
| `very_low_volume` | 0.35 | median 1-10 views/day |
| `low_volume` | 0.15 | median 10-50 views/day |
| `changepoint` | 0.35 | a permanent level shift. **Disqualifying.** |
| `spike_sign_flip` | 0.3 | removing spike days flips the year-over-year sign |
| `monthly_spike` | 0.25 | up to 3 months far above the rest |
| `spike_heavy` | 0.2 | over 20% of views fall on spike days |
| `sparse` | 0.15 | over 10% of days have no upstream data |
| `short_history` | 0.2 | fewer than 24 complete months |

Two rules are **disqualifying**: they force `low` whatever the score, because
they are categorical rather than matters of degree. A series with no traffic has
no trend to measure, and one with a level shift has stopped measuring a single
consistent thing.

### How each detector avoids crying wolf

Detection runs on the **underlying series, never the sparkline**. An eight-level
display glyph puts the peak month at level 7 by definition, so pattern-matching
on it flags about a third of all rows.

**Spikes** use a median-absolute-deviation z-score on `log1p(views)`, cut off at
3.5. The log stops a busy article's normal variation swamping a quiet one's.
Guards: a near-constant series has MAD 0, so a ratio-to-median fallback applies,
and only when the median is at least 1; and flagged days must stay rare (under
5% of the window), or the series is merely dispersed.

**Monthly spikes** exist because daily MAD misses a bump spread over thirty
days. Two ways in: the z-score, or a month at 4x the median. At most 3 months
may flag — more than that is a level change, not an event.

**Changepoints** are the hardest, because a steadily declining series also has a
"best split". Three conditions must all hold:

1. the move is **abrupt** — at least 60% of the window's total change happens
   across the three months either side of the split;
2. it is **large** — a ratio of 1.8x or more;
3. the segments are **severed** — no month after the split reaches any month
   before it.

Segment levels use medians, not means, so a spike adjacent to the split cannot
manufacture a step. And the detector does not run at all below 100 views/month,
because a ratio on tiny counts means nothing.

Each condition was added because a real article defeated the previous version:
English "Electric car" (a spike beside a gradual decline), French "Voiture
electrique" (a decline that recovers), Ukrainian "Золотодобувна промисловість"
(26 to 12 views/month).

## What is still NOT computed

No significance test (Mann-Kendall, Sen's slope), no seasonal decomposition, no
bot-contamination tracking, no redirect accounting. See [roadmap.md](roadmap.md).
