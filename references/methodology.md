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

## What is deliberately NOT computed in this version

No quality gating: no volume floor, no spike detection, no changepoint
detection, no significance test, no confidence score. Everything measurable is
reported with its monthly shape so a reader can see trouble.

The evidence for adding these, and the intended design, is in
[roadmap.md](roadmap.md).
