# wiki-interest-trends

An [Agent Skill](https://agentskills.io/specification) that measures how
interest in a topic changes across Wikipedia language editions, and produces a
one-page PDF report.

Built for product teams deciding which topics to invest in and which languages
to launch in.

## Setup

```bash
export WT_CONTACT="you@example.com"   # required: Wikimedia returns 403 without it
npm ci                                 # only needed for PDF output
node scripts/wt.mjs doctor
```

Node 18+. The analysis core has **no dependencies** — it uses built-in `fetch`
and runs without `npm install`. Only PDF output needs `pdfkit`, which is pure
JavaScript; there are no native builds and no compiled artifacts.

## Use

```bash
node scripts/wt.mjs views "gold mining" --langs en,es,ru,uk --since 2y --table
node scripts/wt.mjs report --run <run_id> --pdf report.pdf
```

```
lang  article                      prior   recent  raw     norm    shape
en    Gold mining                  127119  100909  -20.6%  -14.7%  ▇██▇▇▆▇▆▇▆▆▆▆▇▇▆▇▆▆▅▅▅▄▅
es    Minería del oro              18986   2927    -84.6%  -80.5%  ▇███▆▇▆▅▃▂▂▁▁▁▁▁▁▁▂▂▂▂▂▂
ru    Золотодобыча                 40630   24267   -40.3%  -23.7%  ▆█▇▆▆▆▆▆▅▄▄▄▄▅▄▄▅▄▄▄▃▃▂▃
uk    Золотодобувна промисловість  261     166     -36.4%  -15.6%  ▅▆█▇▇▇▇█▇▃▄▄▄▄▅▄█▅▄▄▄▃▃▄
gap   de: folded_into_broader_article - "Goldbergbau" redirects to "Gold" (Q897)
gap   pl: no_article - Q1071389 has no plwiki sitelink
```

Read `norm`, not `raw`: every edition is losing human traffic at its own rate,
so raw counts make every topic look like it is dying. Read the `shape` too — the
Spanish cliff above is an article rename, not a market collapse.

## Report

Two pages: insights, charts and findings on page 1; the month-by-month numbers
behind them on page 2. Figures there are abbreviated so the table fits; the run
directory always holds exact values.

## Tests

```bash
npm test                      # offline, fixture-based
npx skills-ref validate .     # Agent Skills spec compliance
node evals/run.mjs --dry-run  # validate eval scenarios
```

## Documentation

- `SKILL.md` — what the agent reads
- `references/cli.md` — flags, environment, error codes
- `references/data-caveats.md` — why the numbers behave as they do, with evidence
- `references/methodology.md` — exactly how each figure is computed
- `references/roadmap.md` — how to develop this further

## Status

v1 reports raw measurements with no quality gating, clearly labelled. Quality
gating — volume floors, spike and changepoint detection, significance testing,
a confidence rubric — is designed and evidenced in `references/roadmap.md`.
