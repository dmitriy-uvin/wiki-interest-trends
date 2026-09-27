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
2. Otherwise full-text search that edition (top 10 hits) and pick a winner among
   the non-disambiguation hits. **Not** simply the first: search rank is not
   reproducible — two "Mercury" queries minutes apart ranked the element, the
   planet and Freddie Mercury differently, which would measure a different concept
   on identical input. Instead prefer candidates whose title *is* the queried name
   once a disambiguating qualifier is stripped, then the largest article among
   them, then the lowest Wikidata id. Where no candidate matches the name, search
   rank is genuine relevance and is kept. Losing candidates are returned in
   `other_candidates`.
3. Otherwise search Wikidata entities directly.

Steps 1 and 2 share one request: MediaWiki accepts several `titles` and a `list=`
in the same query, so the exact-title lookup, the search, and the check for a
`<topic> (disambiguation)` page cost one round trip together.

**Rival senses.** When the name has a disambiguation page, its links are read once
(`generator=links` with `prop=info|pageprops`, so each sense arrives with its size
and Wikidata id) and filtered to genuine rival readings — a title that becomes the
query once its qualifier is stripped. `Java (programming language)` and `Apple Inc.`
qualify; `Buddhist meditation` and `Gold mining in Peru` do not, being narrower
articles about the topic rather than other meanings of the name. Survivors are
reported as `other_senses` and cap `entity.confidence` at `medium`, including on an
exact-title match: a page existing at "Java" proves the string, not the meaning.

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
| `changepoint_article_event` | 0.35 | a permanent level shift **with** a move/deletion/protection logged around that month. **Disqualifying.** |
| `changepoint_unexplained` | 0.35 | a permanent level shift with nothing logged to explain it. **Disqualifying.** |
| `spike_sign_flip` | 0.3 | removing spike days flips the year-over-year sign |
| `monthly_spike` | 0.25 | up to 3 months far above the rest |
| `spike_heavy` | 0.2 | over 20% of views fall on spike days |
| `sparse` | 0.15 | over 10% of days have no upstream data |
| `short_history` | 0.2 | fewer than 24 complete months |

Both changepoint rules disqualify the period comparison, because the two halves of
the window are not the same measurement either way. They are separate rules
because the report has to say different things:

- **article event** — en `X (social network)` rises 128.9× at `202603` and the log
  shows `move/move` plus `protect/move_prot`. The article was moved onto that
  title. Nothing about interest changed, and the figure must not be reported as a
  market signal at all.
- **unexplained** — es `Minería del oro` falls 8.3× at `202505` with no move, no
  deletion and no edits logged, and all-agents traffic falls with it. The shift is
  real and nobody can say why. Report the shift and its date; the percentage
  compares two different levels and means nothing.

When the log check could not run, the reason says only that the series is not
measuring one thing throughout — it never claims an absence of activity it did not
verify.

Three rules are **disqualifying**: they force `low` whatever the score, because
they are categorical rather than matters of degree. A series with no traffic has no
trend to measure, and one with a level shift — of either kind — has stopped
measuring a single consistent thing.

### How each detector avoids crying wolf

Detection runs on the **underlying series, never the sparkline**. An eight-level
display glyph puts the peak month at level 7 by definition, so pattern-matching
on it flagged 44% of rows, against this rubric's 5%.

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

## Terminology and constants

Everything the detectors rely on, and why each value is what it is.
`scripts/lib/quality.mjs` points here rather than repeating it.

### Why medians, not means

Every statistic here is built from medians. The mean and standard deviation are
dragged by the very outliers being hunted — one 50,000-view day inflates the sd
enough to hide itself. In the usual terms, the median has a **breakdown point**
of 50% (half the data must be corrupted before it misleads) while the mean's is
0% (a single point can move it arbitrarily far).

The same applies to the spread measure. Instead of the standard deviation the
detectors use the **median absolute deviation**:

```
MAD = median( |xᵢ − median(x)| )
```

### Why log1p

Pageview traffic is multiplicative and right-skewed, so variation is
proportional rather than absolute. A quiet article going 1 → 10 and a busy one
going 1,000 → 10,000 are the same event — a tenfold rise — but on a raw scale
the second dwarfs the first, and any threshold tuned for one is useless for the
other. Taking logs makes them equal.

`log1p(x)` is `log(1 + x)`, used instead of `log(x)` so that zero-view days give
0 rather than −∞.

A consequence worth remembering: differences in log space are **ratios** in the
original space, which is why the changepoint detector raises its computed jump
back through `Math.exp()` to report "8.3x".

### The modified z-score

An ordinary z-score is `(x − mean) / sd`. Swapping in robust statistics gives
the **modified z-score** of Iglewicz & Hoaglin (1993):

```
z = 0.6745 · (x − median) / MAD
```

**Why 0.6745.** It is Φ⁻¹(0.75), the 75th percentile of the standard normal
distribution. For normally distributed data MAD ≈ 0.6745·σ, so multiplying by it
converts the MAD-based deviation back into standard-deviation units. The result
reads on the same familiar scale as a plain z-score — "three sigma" means what
you expect — while remaining robust to outliers.

**Why the cut-off is 3.5.** That is the value Iglewicz & Hoaglin recommend.
Under normality it corresponds to roughly 0.05% of observations, about one day in
2,000, so on a 730-day window a flagged day is genuinely unusual. Lowering it to
3.0 roughly triples the flag rate.

Both constants are standard and should not be adjusted to make a particular
article behave.

### Tuned thresholds

These are calibrated against observed articles, not derived from theory. Each
exists because a real series defeated the version without it, and
`tests/quality.test.mjs` pins the resulting behaviour.

| constant | value | why this value |
|---|---|---|
| `SPIKE_MAX_DAY_SHARE` | 0.05 | Spikes are rare by definition. Past 5% of days, the series is dispersed rather than spiky. |
| `MONTH_SPIKE_RATIO` | 4× median | Catches obvious events the z-score just misses: Turkish "gold mining" peaked at 424 against a median of 72 — 5.9× — and scored only z = 3.3. |
| `MONTH_SPIKE_MAX` | 3 months | More than this is a level change, not spikes. A break's seven-month pre-period all flagged as "spikes" against the post-break median. |
| `CP_MIN_LEVEL` | 100 views/month | Below this a ratio is meaningless: Ukrainian "Золотодобувна промисловість" scored a "2.1× drop" going from 26 to 12 views/month. |
| `CP_MIN_RATIO` | 1.8× | Sits below the smallest genuine break observed (8.3×) and above ordinary decline. |
| `CP_MIN_ABRUPTNESS` | 0.6 | At least 60% of the window's total change must land at the split, separating a step from a slope. |
| `CP_MIN_SEGMENT` | 4 months | Months required either side of a candidate split, so a series edge cannot masquerade as a break. |
| `CP_WINDOW` | 3 months | Months averaged either side of the split to size the jump. |
| `SENSE_MIN_BYTES` | 20,000 | A rival sense is only worth naming if it is a developed article. Observed on en: `Turkey (bird)` 41,214 against `Turkey (nickname)` 710; `Meditation (Maryon)`, a painting, 14,610. The floor sits between them. |
| `SENSE_MIN_SHARE` | 0.5 | Alternative test for smaller editions, where 20 kB means something different: half the measured article's size. |
| `SENSE_MAX` | 3 senses | A report bullet naming six senses is not read. |
| `LABELS.high` / `.medium` | 0.7 / 0.4 | Score thresholds for the label. |

The deduction costs in the rubric table above are likewise a judgement about how
much each problem should discount a figure, not a measured quantity.

## What is still NOT computed

No significance test (Mann-Kendall, Sen's slope), no seasonal decomposition, no
bot-contamination tracking, no redirect accounting. See [roadmap.md](roadmap.md).
