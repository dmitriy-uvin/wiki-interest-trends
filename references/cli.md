# CLI reference

All commands are `node scripts/wt.mjs <command>` from the skill directory.
All print JSON to stdout. Errors print a single JSON object with `error`,
`message` and usually `fix`, and exit with status 1.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `WT_CONTACT` | yes | Email or project URL. Wikimedia returns **403** without a contact-bearing User-Agent. |
| `WT_CACHE_DIR` | no | Cache location. Default `${XDG_CACHE_HOME:-~/.cache}/wiki-interest-trends`. |
| `WT_OUT_DIR` | no | Where run directories are written. Default `./wt-out`. |
| `WT_NO_CACHE` | no | `1` bypasses the cache entirely: always fetch live, never write to disk. Same as `--no-cache`. |
| `WT_DEBUG` | no | `1` traces every API call, its status, timing, and every cache hit or miss — on **stderr**, so piping stdout to `jq` still works. |
| `WT_FIXTURES` | no | `1` replays recorded fixtures instead of the network. Used by the test suite. |
| `WT_RECORD` | no | `1` records live responses as fixtures while running normally. |

## `wt doctor`

Environment and connectivity check. Run it first whenever anything fails.
Reports Node version, the User-Agent it will send, a live API round-trip,
whether PDF dependencies are installed, and cache size.

## `wt views <topic> --langs <codes>`

The main command: resolve → fetch → normalize → summarize.

| Flag | Default | Meaning |
|---|---|---|
| `--langs` | *required* | Comma-separated language edition codes: `en,de,uk`. Not country codes. |
| `--since` | `2y` | Window length in complete months. Accepts `2y`, `18m`, `90d`. |
| `--from` | `en` | Which edition to resolve the topic phrase in. |
| `--no-verify` | off | Skip the per-title existence check. One fewer request per language, but redirects and disambiguation pages stop being detected. |
| `--allow-fold` | off | Measure the broader article a concept folds into instead of reporting it as a gap. Flagged `measures_broader_topic`. |
| `--table` | off | Print a fixed-width table instead of JSON. |
| `--no-cache` | off | Ignore and bypass the cache. Every series is re-fetched and nothing is written to disk. |

The window is always a whole number of **complete** months ending with the last
complete month, because partial months distort every comparison and project
totals only exist per whole month. `--since 2y` compares the most recent 12
complete months against the 12 before them, so it needs 24 months of history.

Writes `wt-out/runs/<run_id>/` containing `analysis.json`, `input.json`, and per
language `series/<lang>.daily.ndjson` and `series/<lang>.monthly.ndjson`.

## `wt resolve <topic> --langs <codes>`

Resolution only, no pageview data. Useful for checking what would be measured
before spending requests, or for diagnosing a surprising result.

Flags: `--langs`, `--from`, `--no-verify`, `--allow-fold` as above.

### Which concept was measured

`entity` carries the resolution and how much to trust it:

| field | meaning |
|---|---|
| `qid`, `label`, `description` | the Wikidata item actually measured |
| `via` | `exact-title`, `wiki-search` or `wikidata-search` — how it was found |
| `confidence` + `why` | whether the phrase found the intended concept |
| `other_senses` | other articles that claim the same name, with their QIDs |
| `other_candidates` | lower-ranked search hits (a weaker signal than `other_senses`) |

`other_senses` holds only rival *readings* of the name — a title that becomes the
query once its qualifier is stripped, so `Java (programming language)` and
`Apple Inc.` qualify while `Buddhist meditation` and `Gold mining in Peru` do not.
Anything listed there caps `confidence` at `medium`, including on an exact title
match: that a page exists at "Java" says the string is right, not which meaning
was wanted.

Which sense wins is decided without reference to search rank, because rank is not
reproducible — two "Mercury" queries minutes apart ranked the element, the planet
and Freddie Mercury in different orders, which would have measured different
concepts on identical input. The rule: prefer titles that ARE the queried name,
then the longest article among them (a depth proxy), then the lowest QID. Article
size, not item age: ordering by QID put a 1978 missile ahead of the Python
programming language.

Senses are read from the name's **disambiguation page**, not from search results:
rank is too unstable at the tail, and `Turkey (bird)` moved in and out of the top
ten between two recordings. One extra request, made only for a name Wikipedia
disambiguates, and only developed articles are listed — at least 20 kB, or half
the measured article's size, capped at three and ordered by size. That floor sits
above `Meditation (Maryon)` (14.6 kB, a painting) and below `Turkey (bird)`
(41.2 kB), which is the line between a plausible alternative and an index entry.

A sense the disambiguation page does not list is not detected, and senses are
looked up only in the resolution edition (`--from`).

## `wt report --run <run_id>`

Builds outputs from an existing run. **Makes zero API calls.**

The PDF is two pages: page 1 carries the summary table, both charts and the
findings; page 2 carries the underlying period-by-period figures. Values there
are abbreviated (`193k`, `1.2M`) and periods are compact (`01.26`, `Q1 24`),
because that is what lets 24 rows and up to 12 language columns fit. Windows
longer than 66 months switch from months to quarters automatically. Exact
figures are always in the run directory's `series/<lang>.monthly.ndjson`.

When the limitations block will not fit on page 1 (roughly 7+ languages), it
moves to page 2 and page 1 says so.

| Flag | Default | Meaning |
|---|---|---|
| `--run` | one of run/dir | Run id from a previous `wt views`. |
| `--dir` | — | Path to a run directory, instead of `--run`. |
| `--pdf` | `report.pdf` | Output path for the PDF (2 pages: findings, then the figures behind them). |
| `--svg` | — | Also write a standalone SVG of the indexed chart. |
| `--notes` | — | Prose to place in the "Analyst notes" box. Checked by `wt check` before rendering: an `error`-severity finding aborts with `notes_unverified` and no file is written; warnings are returned in `notes_warnings` and the PDF is still built. |

Requires `npm install` (pdfkit). Without it you get
`{"error":"pdf_deps_missing","fix":"run: npm install"}`.

## `wt check --run <run_id> <text>`

Compares a block of prose against the run it claims to describe. Pure local
computation over `analysis.json`: **zero API calls**, no model in the loop.

```bash
wt check --run r_20260926103430_24b779 "Romanian fell 30.2%, Ukrainian 33.8%."
wt check --run r_20260926103430_24b779 --claims draft.md
echo "$answer" | wt check --run r_20260926103430_24b779 --claims -
```

| Flag | Default | Meaning |
|---|---|---|
| `--run` | one of run/dir | Run id from a previous `wt views`. |
| `--dir` | — | Path to a run directory, instead of `--run`. |
| `--claims` | — | File to read the text from, or `-` for stdin. Omit it and pass the text as a positional argument. stdin is read **only** for `-`, so the command cannot hang waiting on a pipe nobody writes to. |

Findings, with severity:

| `id` | Severity | What it means |
|---|---|---|
| `untraceable_figure` | error | A number in the text appears nowhere in the run. Comparison is numeric, not substring, with a 0.5 absolute / 2% relative tolerance for figures rounded in prose. Integers ≤24 and years are ignored. |
| `direction_conflict` | error | A magnitude that matches a `yoy_pct` is presented against that figure's sign — a -30.2% written as growth. This is the failure a number-only check cannot see, because the magnitude is real. |
| `misattributed_figure` | warning | The figure exists in the run, but in a different language's row. |
| `low_confidence_quoted` | warning | A `low`-confidence row's comparison figure is quoted with no hedging language in the same sentence (hard rule 4). |

Exit code is 1 when there is at least one error, 0 otherwise; the JSON is printed
either way, with `ok`, `errors` and `warnings`.

Why the severities split there: `error` gates the PDF, and the two error cases are
categorically wrong whatever the surrounding prose. Attribution and hedging are
heuristics over English sentences, so they inform rather than block — a gate that
rejects a correct report teaches an agent to stop using `--notes` at all.

Limits, stated because relying on more than this would be a mistake: the checker
reads figures, signs and which edition a sentence is about. A sentence with no
number in it is invisible to it, as is a real figure framed as something it is not
(a year-over-year percentage described as a market share). Attribution needs a
single subject, so nothing is attributed inside a sentence that names two
editions.

## Error codes

| `error` | Meaning | Fix |
|---|---|---|
| `missing_contact` | `WT_CONTACT` unset | Export it. |
| `forbidden` | 403 from Wikimedia | Usually a User-Agent problem; check `WT_CONTACT`. |
| `topic_not_found` | No article or Wikidata item matched | Use a more specific phrase, or resolve in another language with `--from`. |
| `no_langs` / `no_topic` / `no_claims` | Missing argument | Supply it. |
| `notes_unverified` | `--notes` states a figure the run does not support | The message names each one; quote it as printed or drop it. |
| `run_not_found` | No run data at that path | Run `wt views` first. |
| `pdf_deps_missing` | pdfkit not installed | `npm install`. |
| `upstream` | 429 or 5xx after retries | Wait and retry; requests already back off exponentially. |
| `network` | The request never completed | Check connectivity; `wt doctor` tests a live round-trip. |
| `bad_json` | The endpoint answered with something that is not JSON | Usually transient; retry, then check `WT_DEBUG=1` output. |
| `no_run` | Neither `--run` nor `--dir` was given | Pass the `run_id` from a previous `wt views`. |
| `unknown_command` | No such subcommand | `wt --help`. |
| `fixture_missing` | Test mode, no recorded response | Re-run with `WT_RECORD=1` and no `WT_FIXTURES`. |

## Caching

Series are cached per `(project, title, access, agent, granularity)`. Only the
missing head and tail of a requested range are fetched. Data older than three
days is treated as final and never re-fetched; the trailing few days are always
refreshed because upstream still revises them.

A repeated identical query makes **zero** pageview API calls. Adding a language
to an existing comparison fetches only that language.

Resolution (Wikidata lookup and title verification) is **not** cached, so a warm
run still makes about **4 requests plus 1 per resolved language** before touching
pageviews: the topic lookup, the search-hit pageprops, two Wikidata calls
(sitelinks and labels), then one title check per language. Add one more when a
language has no article (a langlinks call to explain the gap) and one when the name
has a disambiguation page.

Measured for `--langs en,de,fr`: **7 requests warm against 10 cold.**

To bypass the cache: `--no-cache`, or `WT_NO_CACHE=1`. To clear it, delete the
directory `wt doctor` reports under `cache.dir`.

## Debugging

Work outward from the cheapest check.

| Symptom | Do this |
|---|---|
| Any failure, 403, empty output | `wt doctor` — Node version, User-Agent, live round-trip, deps, cache size |
| "Did it even call the API?" | `WT_DEBUG=1 wt views ... > /dev/null` — every request and cache decision on stderr |
| Wrong article measured | `wt resolve "<topic>" --langs ...` — shows the entity, the title per language, `other_senses` (rival readings of the name) and `other_candidates` |
| A number looks wrong | Read `wt-out/runs/<run_id>/series/<lang>.monthly.ndjson` — the months behind the figure, with `per_million` |
| Suspicious cliff or spike | Same file. A step change that never recovers means the series stopped measuring one thing; `confidence_reasons` says whether the logs explain it. A single tall month is one viral event |
| Stale or corrupted data | `rm -rf "$(wt doctor \| jq -r .cache.dir)"` then re-run |
| Logic regression | `npm test` — 93 offline fixture tests, no network |
| The agent misbehaves, not the code | `node evals/run.mjs --model <id> --only <scenario>`, then read the transcript in `evals/results/` |

`analysis.json` in each run directory is the exact object the agent saw. If the
agent said something the data does not support, diff its claim against that file.
