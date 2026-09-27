# wiki-interest-trends

An [Agent Skill](https://agentskills.io/specification) that measures how interest
in a topic changes across Wikipedia language editions, and produces a shareable
PDF report — one page of findings, with the figures behind them on a second page.

Built for product teams deciding which topics to invest in and which languages to
launch in: *is interest in astronomy growing in Ukrainian?*, *should we localise
into Polish or Czech?*, *which audience do we look at next?*

The agent reads [`SKILL.md`](SKILL.md) and runs the CLI in `scripts/`. All the data
work happens in the code — the agent chooses commands, reads their output and
writes prose, and is never asked to do arithmetic.

## What it actually does

1. **Resolves a topic phrase to one article per language edition** via Wikidata
   sitelinks. This is where accuracy is won or lost: a wrong article produces a
   perfectly clean number for the wrong thing. Ambiguous names are flagged —
   `"Java"` resolves to the Indonesian island and says so, with
   *Java (programming language)* offered as another sense.
2. **Fetches daily pageviews** (human traffic only, `agent=user`) from the
   Wikimedia Analytics API, caching everything on disk.
3. **Normalises per edition.** Every edition is losing human readers at its own
   rate — roughly -7%/year for `en`, -25%/year for `uk` — so raw counts make every
   topic look like it is dying. Figures are reported as views per million of that
   project's total traffic, which is what makes editions comparable.
4. **Rates every figure before it is quoted.** A fixed, documented rubric
   (`scripts/lib/quality.mjs`) checks volume, level shifts, spikes, data gaps and
   history length, and returns `high`/`medium`/`low` with a plain-language reason
   for every deduction. It is computed, not judged, so it is identical every run.
5. **Reports gaps as findings.** A language with no article is a content gap, not
   zero interest. Polish has no intermittent-fasting article, and the correct
   answer says so rather than reporting a flat line.
6. **Builds the PDF from the data**, not from narration, and **checks the agent's
   own prose** against the run before it is sent.

## Requirements

- **Node.js 18+** (uses built-in `fetch`)
- **Network access** to `wikimedia.org` and `wikipedia.org`
- **`WT_CONTACT`** — an email or project URL. Wikimedia returns **403** without a
  contact-bearing User-Agent.

The analysis core has **no dependencies**. Only PDF output needs `pdfkit`, which is
pure JavaScript — no native builds, no compiled artifacts in the repo.

## Installation

```bash
git clone https://github.com/dmitriy-uvin/wiki-interest-trends.git
cd wiki-interest-trends
npm ci                                 # only needed for PDF output
export WT_CONTACT="you@example.com"    # put this in ~/.zshrc or ~/.bashrc
node scripts/wt.mjs doctor             # verifies env, network and PDF deps
```

`doctor` prints `"ok": true` when everything is in place. If any command ever
fails, run it first — it names exactly what is wrong.

### Install as a skill for an agent

For Claude Code, the skill directory goes in `~/.claude/skills/`. A symlink keeps
the repo as the single source of truth, so edits take effect with no reinstall:

```bash
ln -s "$(pwd)" ~/.claude/skills/wiki-interest-trends
```

Copy the directory instead if you prefer a fixed snapshot:

```bash
cp -R "$(pwd)" ~/.claude/skills/wiki-interest-trends
```

Then start a new session and ask something the skill covers ("is interest in
astronomy growing in Ukrainian Wikipedia?"). For other agent runtimes, point them
at this directory as an Agent Skill; the contract is `SKILL.md` plus the CLI.

**`WT_CONTACT` must be set in the environment the agent runs in**, not only in
your interactive shell — a tool-running subprocess does not always inherit a shell
profile. Export it from `~/.zshrc` (or your agent's env config) and confirm with
`node scripts/wt.mjs doctor`.

## Use

```bash
node scripts/wt.mjs doctor                                            # check the setup
node scripts/wt.mjs resolve "gold mining" --langs en,de               # which article per edition
node scripts/wt.mjs views  "gold mining" --langs en,es,ru,uk --table  # measure
node scripts/wt.mjs check  --run <run_id> "Russian fell 23.7%."       # verify a draft answer
node scripts/wt.mjs report --run <run_id> --pdf report.pdf            # build the PDF
```

Every command prints JSON on stdout (add `--table` to `views` for humans) and
writes bulk data to `wt-out/runs/<run_id>/`. That split is deliberate: two years of
daily views for one article is ~106 KB, about 30k tokens if it reached an agent's
context. Agents get summaries and file paths.

```
lang  article                      prior   recent  raw     norm    shape
en    Gold mining                  127119  100909  -20.6%  -14.7%  ▇██▇▇▆▇▆▇▆▆▆▆▇▇▆▇▆▆▅▅▅▄▅
es    Minería del oro              18986   2927    -84.6%  -80.5%  ▇███▆▇▆▅▃▂▂▁▁▁▁▁▁▁▂▂▂▂▂▂
ru    Золотодобыча                 40630   24267   -40.3%  -23.7%  ▆█▇▆▆▆▆▆▅▄▄▄▄▅▄▄▅▄▄▄▃▃▂▃
uk    Золотодобувна промисловість  261     166     -36.4%  -15.6%  ▅▆█▇▇▇▇█▇▃▄▄▄▄▅▄█▅▄▄▄▃▃▄
gap   de: folded_into_broader_article - "Goldbergbau" redirects to "Gold" (Q897)
gap   pl: no_article - Q1071389 has no plwiki sitelink
```

Read `norm`, not `raw`. Read the `shape` too — the Spanish cliff above is a level
break rather than a market collapse, and the rubric rates that row `low` for
exactly that reason. (Its cause is unverified: the move and deletion logs are
empty, so the skill reports it as a real but unexplained shift, not as a rename.)

### Key flags

| flag | default | meaning |
|---|---|---|
| `--langs` | required | language edition codes (`en,de,uk`), **not** country codes |
| `--since` | `2y` | window in complete months: `2y`, `18m`, `90d` |
| `--from` | `en` | edition the topic phrase is resolved in |
| `--table` | off | human-readable table instead of JSON |
| `--allow-fold` | off | measure the broader article a topic folds into, flagged as inflated |
| `--notes` | — | (`report`) your own prose, checked against the run before rendering |

Full reference, error codes and caching behaviour: [`references/cli.md`](references/cli.md).

## Confidence, and the two kinds of break

Every measured row carries `confidence` plus `confidence_reasons`. A `low` row is
not a finding, and the reason says why in words a report can quote:

```
median 3 views/day — a percentage on this much traffic is mostly noise
1 month(s) far above the rest carry 20% of all views (202409) — one event, not a trend
```

A permanent level shift is investigated rather than guessed at: the skill queries
Wikipedia's move, deletion and revision logs for that month, and the two possible
answers say different things.

- **Article event** — en `X (social network)` rises 128.9x at `202603` with
  `move/move` logged. The article was moved onto that title; nothing about interest
  changed.
- **Unexplained** — es `Minería del oro` falls 8.3x at `202505` with nothing logged
  at all. The shift is real and nobody can say why, so the report gives the shift
  and its date, not a percentage comparing two different levels.

## Report

Two pages: insights, charts and findings on page 1; the month-by-month figures
behind them on page 2. Numbers there are abbreviated so the table fits; the run
directory always holds exact values.

Every figure on the page is filled from `analysis.json`, and the assumptions and
limitations block is derived from the data rather than written by hand. The one
agent-authored region is the "Analyst notes" box, and `--notes` is checked before
anything is rendered: a figure the data does not support aborts the build instead
of reaching a reader.

## Checking an answer

```bash
node scripts/wt.mjs check --run <run_id> "Romanian fell 30.2%, Ukrainian 33.8%."
```

`wt check` reads a draft answer and reports figures that appear nowhere in the run,
figures quoted against their own sign (a -30.2% presented as growth), figures
belonging to another edition's row, and low-confidence figures quoted with no
caveat. Local, deterministic, zero API calls — the same function the eval harness
scores and the PDF gate uses, so all three agree by construction.

What it cannot judge is a claim with no number in it.

## What this does not tell you

Stated plainly, because the reports are meant to be trusted:

- **Pageviews measure curiosity, not willingness to pay.** Treat any finding as a
  direction to validate, not as demand.
- **A language edition is not a country.** `en` serves the US, Australia, Canada,
  South Africa and Ghana alike; this API has no country breakdown.
- **A flagship article is a thin proxy for a topic.** Ukrainian `Астрономія` drew
  16,614 views while eight related astronomy articles drew 258,870.
- **No significance test yet.** A year-over-year figure carries no confidence
  interval, so "growing" is not yet "growing beyond noise".
- **Bot contamination and redirect traffic are not yet accounted for**, and
  ambiguous-name detection looks only at the resolution edition.

The evidence behind each, and the plan for closing them, is in
[`references/data-caveats.md`](references/data-caveats.md) and
[`references/roadmap.md`](references/roadmap.md).

## Tests

```bash
npm test                        # 93 tests, offline, fixture-based
npx skills-ref validate .       # Agent Skills spec compliance
node evals/run.mjs --dry-run    # validate eval scenarios without a key
```

Unit tests run against recorded HTTP fixtures, so the suite is offline and
deterministic. Fixtures are keyed by request URL; change a request and its
recording is orphaned, so the affected tests fail with `fixture_missing`:

```bash
WT_CONTACT="you@example.com" npm run record-fixtures   # needs network
```

`tests/golden-topics.jsonl` pins topic -> Wikidata entity for 13 topics, including
the ambiguous ones and two non-topics that must be rated `low`. Expected values
were verified by hand against each item's Wikidata description.

There is also an **agent-level** eval: a cheap model drives the skill through
`SKILL.md` and is scored on whether it ran the right commands and whether every
figure in its answer appeared in command output.

```bash
OPENROUTER_API_KEY=... node evals/run.mjs --model "<cheap-model-id>"
node evals/run-claude.mjs      # via the Claude Code CLI
```

Scores vary between runs on identical code, so average several before concluding
anything. See [`evals/README.md`](evals/README.md).

## Layout

```
SKILL.md              what the agent reads
scripts/wt.mjs        CLI entry point
scripts/lib/          resolve, aqs, dates, series, sparkline, quality, claims,
                      views, chart, report, cache, http
references/           cli, methodology, data-caveats, roadmap
tests/                unit tests, recorded fixtures, golden topic set
evals/                agent-level evaluation harness and scenarios
wt-out/runs/<run_id>/ per-run output: analysis.json + series/*.ndjson (gitignored)
```

## Documentation

- [`SKILL.md`](SKILL.md) — what the agent reads
- [`references/cli.md`](references/cli.md) — every flag, exit codes, environment, caching
- [`references/methodology.md`](references/methodology.md) — exactly how each figure is computed
- [`references/data-caveats.md`](references/data-caveats.md) — why the numbers behave as they do, with evidence
- [`references/roadmap.md`](references/roadmap.md) — how to develop this further
- [`evals/README.md`](evals/README.md) — the agent-level evaluation

## Status

Working end to end on all three examples in the brief. Built: resolution with
ambiguity detection, per-edition normalisation, the confidence rubric (volume
floors, spike, monthly-spike and changepoint detection with log verification), the
PDF, and a claim checker over the agent's own prose.

Designed and evidenced but not built: concept clusters instead of single articles,
significance testing, bot-share and redirect accounting, and bulk-dump loading for
large scans — see [`references/roadmap.md`](references/roadmap.md).

MIT licensed.
