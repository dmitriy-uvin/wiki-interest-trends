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

## `wt report --run <run_id>`

Builds outputs from an existing run. **Makes zero API calls.**

| Flag | Default | Meaning |
|---|---|---|
| `--run` | one of run/dir | Run id from a previous `wt views`. |
| `--dir` | — | Path to a run directory, instead of `--run`. |
| `--pdf` | `report.pdf` | Output path for the one-page PDF. |
| `--svg` | — | Also write a standalone SVG of the indexed chart. |
| `--notes` | — | Prose to place in the "Analyst notes" box. All figures still come from the run's data. |

Requires `npm install` (pdfkit). Without it you get
`{"error":"pdf_deps_missing","fix":"run: npm install"}`.

## Error codes

| `error` | Meaning | Fix |
|---|---|---|
| `missing_contact` | `WT_CONTACT` unset | Export it. |
| `forbidden` | 403 from Wikimedia | Usually a User-Agent problem; check `WT_CONTACT`. |
| `topic_not_found` | No article or Wikidata item matched | Use a more specific phrase, or resolve in another language with `--from`. |
| `no_langs` / `no_topic` | Missing argument | Supply it. |
| `run_not_found` | No run data at that path | Run `wt views` first. |
| `pdf_deps_missing` | pdfkit not installed | `npm install`. |
| `upstream` | 429 or 5xx after retries | Wait and retry; requests already back off exponentially. |
| `fixture_missing` | Test mode, no recorded response | Re-run with `WT_RECORD=1` and no `WT_FIXTURES`. |

## Caching

Series are cached per `(project, title, access, agent, granularity)`. Only the
missing head and tail of a requested range are fetched. Data older than three
days is treated as final and never re-fetched; the trailing few days are always
refreshed because upstream still revises them.

A repeated identical query makes **zero** pageview API calls. Adding a language
to an existing comparison fetches only that language.

Resolution (Wikidata lookup and title verification) is **not** cached, so a warm
run still makes about 2 + 1 per language requests before touching pageviews. For
`--langs en,de,fr` that is 6 calls warm versus 12 cold.

To bypass the cache: `--no-cache`, or `WT_NO_CACHE=1`. To clear it, delete the
directory `wt doctor` reports under `cache.dir`.

## Debugging

Work outward from the cheapest check.

| Symptom | Do this |
|---|---|
| Any failure, 403, empty output | `wt doctor` — Node version, User-Agent, live round-trip, deps, cache size |
| "Did it even call the API?" | `WT_DEBUG=1 wt views ... > /dev/null` — every request and cache decision on stderr |
| Wrong article measured | `wt resolve "<topic>" --langs ...` — shows the entity, the title per language, and `other_candidates` |
| A number looks wrong | Read `wt-out/runs/<run_id>/series/<lang>.monthly.ndjson` — the months behind the figure, with `per_million` |
| Suspicious cliff or spike | Same file. A step change that never recovers is an article rename; a single tall month is one viral event |
| Stale or corrupted data | `rm -rf "$(wt doctor \| jq -r .cache.dir)"` then re-run |
| Logic regression | `npm test` — 29 offline fixture tests, no network |
| The agent misbehaves, not the code | `node evals/run.mjs --model <id> --only <scenario>`, then read the transcript in `evals/results/` |

`analysis.json` in each run directory is the exact object the agent saw. If the
agent said something the data does not support, diff its claim against that file.
