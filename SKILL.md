---
name: wiki-interest-trends
description: Measure how interest in a topic changes across Wikipedia language editions, using Wikimedia pageview data, and produce a one-page PDF report. Use when someone asks which topics are growing, which languages or markets to launch a product in, whether interest in a subject is rising or falling, how a topic compares between languages, or asks for a Wikipedia pageview trend, chart or report.
license: MIT
compatibility: Requires Node.js 18+, network access to wikimedia.org and wikipedia.org, and the WT_CONTACT environment variable. PDF output additionally requires `npm install` in the skill directory.
metadata:
  version: "0.1.0"
---

# Wikipedia interest trends

Turns a topic phrase into measured pageview trends per language edition, plus a
shareable one-page PDF.

## Before anything else

`WT_CONTACT` must be set to an email or project URL. Wikimedia returns **403**
without it. If any command fails, run `wt doctor` first — it reports exactly
what is wrong.

```bash
export WT_CONTACT="you@example.com"
cd <skill directory>
node scripts/wt.mjs doctor
```

## Which command to run

| The user wants | Run |
|---|---|
| How interest in a topic is changing, in one or more languages | `wt views "<topic>" --langs en,de,uk` |
| A comparison between languages | `wt views "<topic>" --langs pl,cs` (same command, more languages) |
| A shareable report / PDF / "something I can send" | `wt views ...` first, then `wt report --run <run_id> --pdf out.pdf` |
| To check which article each language uses, before measuring | `wt resolve "<topic>" --langs en,de` |
| Anything failing, or a 403 | `wt doctor` |

All commands print JSON. Add `--table` to `views` for a human-readable table.

```bash
node scripts/wt.mjs views "intermittent fasting" --langs pl,cs,uk --since 2y
node scripts/wt.mjs report --run r_20260926103430_24b779 --pdf fasting.pdf
```

## Hard rules

1. **Never calculate a trend yourself.** Never sum, average, or compute a
   percentage from the series files. The command already did it.
2. **Never state a number that is not in the command output.** If the user asks
   something the output does not answer, run another command.
3. **Always report the measured article title.** Wikipedia may cover a topic
   under a surprising title — French "gold mining" resolves to *Histoire des
   mines d'or* ("History of gold mines"). Showing the title is how the user
   catches that.
4. **Always mention at least one limitation** when giving a recommendation. The
   most important: pageviews measure curiosity, not willingness to pay.
5. **Never treat an unmeasurable language as zero interest.** See `unresolved`
   below.
6. **Say "language edition", not "country".** They are not the same thing, and
   this API has no country breakdown.

## Reading the output

```json
{
  "run_id": "r_20260926103430_24b779",
  "entity": { "qid": "Q1071389", "label": "gold mining" },
  "window": { "from": "2024-09-01", "to": "2026-08-31", "complete_months": 24 },
  "results": [{
    "lang": "ru",
    "title": "Золотодобыча",
    "median_daily_90d": 58,
    "days_missing": 0,
    "sparkline": "▆█▇▆▆▆▆▆▅▄▄▄▄▅▄▄▅▄▄▄▃▃▂▃",
    "raw":        { "prior": 40630, "recent": 24267, "yoy_pct": -40.3 },
    "normalized": { "prior": 4.07, "recent": 3.10, "yoy_pct": -23.7,
                    "unit": "views per million project views" }
  }],
  "unresolved": [{ "lang": "pl", "reason": "no_article", "detail": "..." }]
}
```

**Quote the `normalized` figure, not the raw one.** Raw counts cannot be
compared between editions and are distorted within one, because every edition is
losing human traffic at its own rate (roughly -7%/year for `en`, -25%/year for
`uk`). Raw says Russian gold mining fell 40%; normalized says 24%, and the
difference is Wikipedia's decline, not the topic's. Mention the raw number only
when the user asks for absolute volume.

`median_daily_90d` is the size of the audience. A topic at 1 view/day has no
meaningful trend no matter what the percentage says — say so.

The `sparkline` is the monthly shape. **A cliff that never recovers means the
article was renamed or merged, not that interest collapsed.** Spanish gold mining
reads `▇███▆▇▆▅▃▂▂▁▁▁▁▁▁▁▂▂▂▂▂▂` and -85%; that is an article event, and
reporting it as a market signal would be wrong. A single tall bar in an otherwise
flat line is one viral moment, not growth.

## When a language cannot be measured

`unresolved` entries are findings, not errors. Report them:

| reason | Means | Say |
|---|---|---|
| `no_article` | No article exists in that edition | A content gap. Possibly an opportunity, definitely not zero interest. |
| `folded_into_broader_article` | The concept redirects into a wider article | No dedicated coverage; the broader article cannot be compared fairly. |
| `title_gone` | Wikidata points at a deleted page | Data issue; try `wt resolve` to find the current title. |

Polish Wikipedia has **no** intermittent-fasting article. The correct answer to
"compare intermittent fasting in Polish and Czech" is that Czech can be measured
and Polish cannot, and why — not "Polish shows no growth".

## When nothing is measurable

If `results` is empty, the output carries a `hint` object explaining that the
topic matched a thinly-covered Wikidata item, plus concrete things to try.
**Follow it rather than reporting failure.** A narrow phrase often matches a real
but rarely-translated concept: "English language learning" matches an item with
16 sitelinks and none for Polish, Czech, Ukrainian, Hungarian or Romanian, while
"English language" resolves everywhere. Retry with the broader phrase, then tell
the user which concept you ended up measuring.

## Follow-up questions

Re-run `wt views` with the changed argument. Results are cached, so adding a
language or changing the window re-fetches only what is missing; a repeat of the
same query makes zero API calls. `wt report --run <run_id>` also makes zero API
calls.

## Options worth knowing

| Flag | Default | Use |
|---|---|---|
| `--since` | `2y` | Window as complete months: `2y`, `18m`, `90d`. Needs 2× the comparison period. |
| `--langs` | required | Comma-separated language codes (`en,de,uk`), not country codes. |
| `--from` | `en` | Which edition to resolve the topic phrase in. Use the user's language for local topics. |
| `--allow-fold` | off | Measure the broader article a topic folds into, flagged as inflated. |
| `--table` | off | Human-readable table instead of JSON. |
| `--notes` | — | (`report`) Your own prose, in a labelled box. Figures always come from the data. |

## More detail

- `references/cli.md` — every flag, exit codes, environment variables
- `references/data-caveats.md` — why the numbers behave as they do
- `references/methodology.md` — exactly how each figure is computed
- `references/roadmap.md` — planned quality gating and how to extend this
