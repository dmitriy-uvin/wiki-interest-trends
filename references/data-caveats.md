# Why the numbers behave the way they do

Every item here was observed against the live API while building this skill, not
taken from documentation. Each one changes an answer.

## Wikipedia is losing human traffic everywhere

Total human pageviews, Sep 2024–Aug 2025 vs Sep 2025–Aug 2026:

| edition | prior 12mo | recent 12mo | change |
|---|---|---|---|
| uk.wikipedia | 900.3M | 678.5M | **−24.6%** |
| cs.wikipedia | 816.0M | 713.2M | −12.6% |
| pl.wikipedia | 2,475.3M | 2,256.9M | −8.8% |
| en.wikipedia | 87.2B | 81.1B | −7.0% |

Two consequences. **Every topic looks like it is dying** if you read raw counts.
And **raw cross-edition comparison is invalid**, because the denominators moved
by very different amounts — a topic can look stronger in Polish purely because
Polish Wikipedia shrank less.

This is why the skill reports views-per-million of each project's own traffic.
The correction is not cosmetic: Vietnamese "gold mining" is **−9% raw but +20%
normalized**, an inverted conclusion.

## A topic is not an article

The API measures exact article titles. Turning a topic phrase into a title per
language is the main source of error.

- **No article at all.** `pl.wikipedia` has no intermittent-fasting article; the
  Wikidata item had 31 sitelinks when this was last checked and none for Polish.
  Reporting 0 views would be wrong; the finding is a content gap.
- **Folded into a broader article.** Wikidata's German sitelink for gold mining
  is `Goldbergbau`, which *redirects to* `Gold` — the chemical element, a
  different Wikidata item (Q897). Measuring it would count interest in gold as
  interest in gold mining. The skill detects this by comparing the redirect
  target's Wikidata id against the topic's.
- **Drifted concept.** French gold mining resolves to `Histoire des mines d'or`
  ("History of gold mines"). Wikidata considers it the same item, so **no
  automated check can reject it**. The mitigation is that the resolved title is
  always printed.
- **Section links.** English langlinks point German at `Gold#Gewinnung`, a
  section. Sections cannot be measured. The skill uses Wikidata sitelinks rather
  than langlinks, which avoids this entirely — for gold mining, sitelinks cover 26
  language editions (28 sitelinks in all, counting Commons and Russian Wikinews)
  against 25 langlinks.
- **Redirects split traffic.** English "Intermittent fasting" has **26** redirects,
  each counted separately, so a title's count is a lower bound. (An earlier draft
  of this file said 10, which was MediaWiki's default `rdlimit` truncating the
  list — a reminder to pass an explicit limit before quoting a count from an API.)
- **Case matters.** `Intermittent_fasting` returns data; `intermittent_fasting`
  returns 404.

## Bots are about a third of raw traffic

English `Astronomy`, August 2026:

| agent filter | views |
|---|---|
| all-agents | 38,448 |
| **user** | **24,843** |
| automated | 8,673 |
| spider | 4,932 |

The skill always requests `agent=user`. Anything quoting all-agents is measuring
crawlers as much as people.

## Missing days are omitted, not zeroed

The API simply leaves out days it has no row for, so a naive average over the
returned items overstates a quiet article. Both cases occur, sometimes in the
same month: Ukrainian gold mining in January 2026 had 9 days of explicit `0` and
2 days with no row at all.

"No data" also arrives in two different shapes — HTTP `404`, or `200` with an
empty `items` list. A title that does not exist gives the former; a real but
untrafficked article gives the latter.

The skill reindexes every series onto a full date axis, stores absent days as
`null`, counts them in `days_missing`, and treats them as zero only when summing.

## The current month is returned incomplete

Monthly granularity happily returns the month in progress as a partial total
(September 2026 came back as 22,187 views with 25 days elapsed). Comparing that
against full months manufactures a collapse. All windows in this skill consist of
complete months only.

Daily data lags roughly one day.

## Language editions are not countries

There is **no per-article country breakdown** in this API — the
`per-article-by-country` path returns 404. Only a project-level `top-by-country`
endpoint exists, covering the most-viewed articles.

The mapping fails in both directions. `en.wikipedia` serves the United States,
Australia, Canada, South Africa, Ghana, India and Nigeria — most of the world's
largest gold producers land in one bucket. Meanwhile Kazakhstan reads `kk` and
`ru`; Canada reads `en` and `fr`.

Every report says "language edition" for this reason.

## Step changes are not market events

Spanish `Minería del oro`, monthly:

```
2025-03  1,982
2025-04  1,330
2025-05    861
2025-06    238   <- 10x drop over two months, never recovers
2025-07    185
```

Markets do not move like that. Whatever the cause, the two halves of the window are
not the same measurement, so the reported −85% is arithmetically correct and
substantively meaningless. The monthly sparkline exists to make this visible.

The obvious explanation is a rename, a merge or lost redirects — but the skill
checks rather than assuming, and for this article the check comes back empty: no
move log, no deletion log, no edits during the drop, and all-agents traffic fell
with `agent=user`. So this one is a real, unexplained collapse, and the rubric
labels it `changepoint_unexplained` rather than claiming a rename.

The contrast case is en `X (social network)`, which **rises** 128.9× at `202603`
with `move/move` and `protect/move_prot` in the log. That is
`changepoint_article_event`: the article was moved onto the title, and nothing about
interest changed.

## Other limits

- Pageview data begins **2015-07-01**. Earlier requests are clamped.
- Low-volume series are noise. Ukrainian gold mining drew 261 views in a *year*
  — 0.7/day. A percentage change on that is not a trend.
- A single tall bar in a flat sparkline is one viral moment. Turkish gold mining
  shows +92% normalized driven by one month.
- Interest is not demand. Nothing here measures willingness to pay.
