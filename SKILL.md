---
name: wiki-interest-trends
description: Measure how interest in a topic changes across Wikipedia language editions, using Wikimedia pageview data, and produce a shareable one-page PDF report, with the monthly figures behind it on a second page. Use when someone asks which topics are growing, which languages or markets to launch a product in, whether interest in a subject is rising or falling, how a topic compares between languages, or asks for a Wikipedia pageview trend, chart or report.
license: MIT
compatibility: Requires Node.js 18+, network access to wikimedia.org and wikipedia.org, and the WT_CONTACT environment variable. PDF output additionally requires `npm install` in the skill directory.
metadata:
  version: "0.1.0"
---

# Wikipedia interest trends

Turns a topic phrase into measured pageview trends per language edition, plus a
shareable PDF: one page of findings, with the month-by-month figures behind them on
a second page.

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
| To check your own draft answer before sending it | `wt check --run <run_id> "<draft>"` |
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
   When `entity.other_senses` is present, the name has more than one meaning —
   say which one you measured and what the alternative was.
4. **Never quote a `confidence: "low"` figure as a finding.** Report what the
   `confidence_reasons` say instead. A detected level shift comes in two kinds and
   they are not the same news: `changepoint_article_event` means the article was
   moved or merged, so the figure is an artifact; `changepoint_unexplained` means
   the drop looks real but the two halves are not comparable, so report the shift
   and its date rather than the percentage.
5. **Always mention at least one limitation** when giving a recommendation. The
   most important: pageviews measure curiosity, not willingness to pay.
6. **Never treat an unmeasurable language as zero interest.** See `unresolved`
   below.
7. **Say "language edition", not "country".** They are not the same thing, and
   this API has no country breakdown.

## Check your answer before you send it

`wt check` compares your draft against the run it came from. No API calls.

```bash
node scripts/wt.mjs check --run r_20260926103430_24b779 "Romanian fell 30.2% year over year, Ukrainian 33.8%."
```

It returns `ok` plus `errors` and `warnings`:

| id | Means |
|---|---|
| `untraceable_figure` | A number that is in no command output. You invented it — remove it or run a command that produces it. |
| `direction_conflict` | A real magnitude quoted against its own sign, e.g. presenting a -30.2% as growth. |
| `misattributed_figure` | A figure that belongs to a different language's row. |
| `low_confidence_quoted` | A `low`-confidence figure quoted with no caveat (hard rule 4). |

Run it whenever your answer states figures, and always before `wt report --notes`
— that flag runs the same check and **refuses** to build the PDF on an error,
because a wrong number in a forwarded PDF outlives the session that made it.

What it cannot check: a claim with no number in it. "Polish shows no growth" is
wrong for a language with no article, and no tool will catch that for you — rule
6 is still yours to keep.

## Reading the output

```json
{
  "run_id": "r_20260926103430_24b779",
  "entity": { "qid": "Q1071389", "label": "gold mining", "via": "exact-title",
              "source_title": "Gold mining", "confidence": "high" },
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

**Check `entity.confidence` too, not only the per-language rows.** It scores
whether the topic phrase found the right *concept*:

| value | meaning |
|---|---|
| `high` | one article carries this name |
| `medium` | check `why` — usually another article shares the name (`other_senses`) |
| `low` | probably the wrong article; `why` says what to do instead |

`"Java"` resolves to the Indonesian island (Q3757), with the programming language
(Q251) in `other_senses`. `"apple"` is the fruit, with Apple Inc. alongside.
`"Turkey"` is the country, with the bird alongside. In each case name the concept
you measured, and offer the other one — the user's next message is often "no, the
other one", and re-running with the exact title (`wt views "Java (programming
language)"`) resolves it directly.

**Check `confidence` before quoting anything.**

| label | meaning |
|---|---|
| `high` | safe to quote |
| `medium` | quote with the reason attached |
| `low` | do not quote as a finding; report the reason instead |

`confidence_reasons` explains every deduction in plain language. For a level
shift it also says what Wikipedia's own logs found, which is the difference
between *"level rise of 128.9x at 202603 (2043 to 263525/month). Wikipedia logs
show 2 event(s) around then (protect/move_prot, move/move) — the article was moved
or merged, so this is not a change in interest"* and *"level drop of 8.3x at 202505
with no recovery. No move, deletion or edit activity is logged around that month —
the shift itself looks real, so report the shift and its date, not the period
percentage"*. The label is computed by a fixed rubric,
not judged, so it is the same every run.

`median_daily_90d` is the size of the audience. A topic at 1 view/day has no
meaningful trend no matter what the percentage says — say so.

The `sparkline` is the monthly shape. **A cliff that never recovers means the
series stopped measuring one consistent thing — so the percentage is not a market
signal.** What caused it is a separate question, and the `confidence_reasons`
answer it: `changepoint_article_event` when the logs show a move or merge,
`changepoint_unexplained` when they show nothing. Spanish gold mining reads
`▇███▆▇▆▅▃▂▂▁▁▁▁▁▁▁▂▂▂▂▂▂` and -85%, and its logs are empty — so the drop is real
but unexplained, and the right answer gives the shift and its date, not the
percentage. A single tall bar in an otherwise flat line is one viral moment, not
growth.

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

Re-run `wt views` with the changed argument. Pageview data is cached, so adding a
language or extending the window fetches only what is missing, and an identical
repeat fetches no pageviews at all.

Resolution is **not** cached, so a repeat still costs about 4 requests plus 1 per
language — measured at 7 warm against 10 cold for `--langs en,de,fr`. Cheaper than
a cold run, not free.

`wt report --run <run_id>` and `wt check --run <run_id>` make **no** API calls at
all, so prefer them over re-running `views` when you already have the run.

## Options worth knowing

| Flag | Default | Use |
|---|---|---|
| `--since` | `2y` | Window as complete months: `2y`, `18m`, `90d`. Needs 2× the comparison period. |
| `--langs` | required | Comma-separated language codes (`en,de,uk`), not country codes. |
| `--from` | `en` | Which edition to resolve the topic phrase in. Use the user's language for local topics. |
| `--allow-fold` | off | Measure the broader article a topic folds into, flagged as inflated. |
| `--table` | off | Human-readable table instead of JSON. |
| `--notes` | — | (`report`) Your own prose, in a labelled box. Checked against the run: a figure the data does not support is refused, not rendered. |

## More detail

- `references/cli.md` — every flag, exit codes, environment variables
- `references/data-caveats.md` — why the numbers behave as they do
- `references/methodology.md` — exactly how each figure is computed
- `references/roadmap.md` — how to develop this further
