#!/usr/bin/env node
// wt — Wikipedia interest trends CLI.
//
// Every subcommand prints compact JSON on stdout and writes bulk data to disk.
// That split is deliberate: two years of daily views for a single article is
// ~106 KB / 731 points, which would cost ~30k tokens if it reached an agent's
// context. Agents get summaries and file paths; the files hold the data.

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { WtError, userAgent } from './lib/http.mjs';
import { resolveTopic } from './lib/resolve.mjs';
import { runViews, renderTable, runDir } from './lib/views.mjs';

const USAGE = `wt — Wikipedia interest trends

  wt doctor
      Check environment, network and data freshness. Run this first if anything fails.

  wt views <topic> --langs en,de,uk [--since 2y] [--table] [--allow-fold] [--no-cache]
      Measure a topic across language editions. Prints a compact summary and
      writes the full series to wt-out/runs/<run_id>/.

  wt report --run <run_id> [--pdf out.pdf] [--svg out.svg] [--notes "..."]
      Build a one-page PDF from an existing run. Uses only cached files, so it
      makes no API calls. --notes adds your own prose in a labelled box; every
      figure on the page comes from the run's data.

  wt check --run <run_id> --claims - | --claims <file> | "<text>"
      Verify a draft answer against the run it came from, before sending it.
      Flags figures that appear nowhere in the data, figures quoted against their
      own sign, figures attributed to the wrong edition, and low-confidence
      figures quoted with no caveat. Exits 1 on errors. No API calls.

  wt resolve <topic> --langs en,de,uk [--from en] [--no-verify] [--allow-fold]
      Show which article each language edition uses for a topic, and why any
      language cannot be measured. --allow-fold measures broader articles that a
      language folds the concept into, instead of reporting them as gaps.

Environment:
  WT_CONTACT   required. Email or project URL; Wikimedia returns 403 without it.
  WT_CACHE_DIR optional. Defaults to \${XDG_CACHE_HOME:-~/.cache}/wiki-interest-trends
`;

// Agents habitually pipe output into head/jq/grep, which can close the pipe
// early. Without this, Node throws an unhandled EPIPE and buries the real result
// under a stack trace.
process.stdout.on('error', (e) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

const out = (obj) => process.stdout.write(JSON.stringify(obj, null, 2) + '\n');

function fail(err) {
  const body = err instanceof WtError ? err.toJSON() : { error: 'internal', message: err.message };
  process.stdout.write(JSON.stringify(body, null, 2) + '\n');
  process.exit(1);
}

const splitLangs = (s) =>
  String(s ?? '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

async function cmdResolve(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      langs: { type: 'string' },
      from: { type: 'string', default: 'en' },
      // parseArgs has no --no-x negation, so the documented negative form is its
      // own option. Without this, `--no-verify` failed with an `internal` error.
      'no-verify': { type: 'boolean', default: false },
      'allow-fold': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const topic = positionals.join(' ').trim();
  if (!topic) throw new WtError('no_topic', 'No topic given.', { fix: 'wt resolve "gold mining" --langs en,de' });
  const langs = splitLangs(values.langs);
  if (!langs.length) throw new WtError('no_langs', 'No languages given.', { fix: 'add --langs en,de,uk' });
  // console.log({ topic, langs });
  // console.log(topic, langs, { fromLang: values.from, verify: values.verify, allowFold: values['allow-fold'] })
  out(await resolveTopic(topic, langs, { fromLang: values.from, verify: !values['no-verify'], allowFold: values['allow-fold'] }));
  // out();
  // await resolveTopic(topic, langs, { fromLang: values.from, verify: values.verify, allowFold: values['allow-fold'] })
}

async function cmdViews(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      langs: { type: 'string' },
      since: { type: 'string', default: '2y' },
      from: { type: 'string', default: 'en' },
      'no-verify': { type: 'boolean', default: false },
      'allow-fold': { type: 'boolean', default: false },
      table: { type: 'boolean', default: false },
      'no-cache': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const topic = positionals.join(' ').trim();
  if (!topic) throw new WtError('no_topic', 'No topic given.', { fix: 'wt views "gold mining" --langs en,ru' });
  const langs = splitLangs(values.langs);
  if (!langs.length) throw new WtError('no_langs', 'No languages given.', { fix: 'add --langs en,de,uk' });

  if (values['no-cache']) process.env.WT_NO_CACHE = '1';

  const summary = await runViews(topic, langs, {
    since: values.since,
    fromLang: values.from,
    verify: !values['no-verify'],
    allowFold: values['allow-fold'],
  });
  if (values.table) process.stdout.write(renderTable(summary) + '\n');
  else out(summary);
}

async function cmdReport(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      run: { type: 'string' },
      dir: { type: 'string' },
      pdf: { type: 'string' },
      svg: { type: 'string' },
      notes: { type: 'string', default: '' },
    },
    strict: true,
  });
  if (!values.run && !values.dir)
    throw new WtError('no_run', 'Nothing to report on.', { fix: 'pass --run <run_id> from a previous `wt views`' });
  const dir = values.dir ?? runDir(values.run);
  const { writePdf, writeSvg } = await import('./lib/report.mjs');

  const artifacts = {};
  let notesWarnings = null;
  try {
    if (values.svg) artifacts.svg = (await writeSvg(dir, values.svg)).path;
    const pdfPath = values.pdf ?? (values.svg ? null : 'report.pdf');
    if (pdfPath) {
      const r = await writePdf(dir, pdfPath, { notes: values.notes });
      artifacts.pdf = r.path;
      artifacts.bytes = r.bytes;
      if (r.notes_warnings?.length) notesWarnings = r.notes_warnings;
    }
  } catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND')
      throw new WtError('pdf_deps_missing', 'pdfkit is not installed.', { fix: 'run: npm install' });
    if (e.code === 'ENOENT')
      throw new WtError('run_not_found', `No run data at ${dir}`, { fix: 'run `wt views ...` first, then pass its run_id' });
    throw e;
  }
  out({ run_id: values.run ?? null, source_dir: dir, artifacts, api_calls: 0, ...(notesWarnings && { notes_warnings: notesWarnings }) });
}

/** Read piped text, so an agent can send a draft answer without writing a file. */
async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function cmdCheck(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      run: { type: 'string' },
      dir: { type: 'string' },
      claims: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });
  if (!values.run && !values.dir)
    throw new WtError('no_run', 'Nothing to check against.', { fix: 'pass --run <run_id> from a previous `wt views`' });
  const dir = values.dir ?? runDir(values.run);

  // stdin is read only when asked for with `--claims -`. Waiting on it by default
  // would hang under any parent that opens stdin as an unwritten pipe, the eval
  // harness included.
  let text = positionals.join(' ').trim();
  if (!text && values.claims) text = values.claims === '-' ? await readStdin() : await readFile(values.claims, 'utf8');
  if (!text.trim())
    throw new WtError('no_claims', 'No text to check.', {
      fix: 'pass the draft as an argument: wt check --run <run_id> "<your draft answer>" (or --claims <file>, or --claims - to pipe it)',
    });

  const { loadAnalysis, checkClaims } = await import('./lib/claims.mjs');
  let analysis;
  try {
    analysis = await loadAnalysis(dir);
  } catch (e) {
    if (e.code === 'ENOENT')
      throw new WtError('run_not_found', `No run data at ${dir}`, { fix: 'run `wt views ...` first, then pass its run_id' });
    throw e;
  }

  const result = checkClaims(analysis, text);
  out({ run_id: values.run ?? null, source_dir: dir, api_calls: 0, ...result });
  // Non-zero on errors as well as the JSON: a shell or CI step should fail, and
  // an agent that ignores JSON still sees the command did not succeed.
  if (!result.ok) process.exit(1);
}

async function cmdDoctor() {
  const report = { node: process.version, ua: null, network: null, pdf_deps: null, warnings: [] };

  try {
    report.ua = userAgent();
  } catch (e) {
    report.ua = 'MISSING';
    report.warnings.push(e.toJSON());
  }

  const major = Number(process.version.slice(1).split('.')[0]);
  if (major < 18) report.warnings.push({ error: 'node_too_old', message: 'Node 18+ required for built-in fetch.' });

  if (report.ua !== 'MISSING') {
    const t0 = Date.now();
    try {
      const { getJson } = await import('./lib/http.mjs');
      const r = await getJson(
        'https://wikimedia.org/api/rest_v1/metrics/pageviews/aggregate/en.wikipedia/all-access/user/daily/20260101/20260102',
      );
      report.network = { ok: true, ms: Date.now() - t0, sample_days: r?.items?.length ?? 0 };
    } catch (e) {
      report.network = { ok: false, detail: e.message };
      report.warnings.push({ error: 'network', message: e.message });
    }
  }

  try {
    await import('pdfkit');
    report.pdf_deps = 'installed';
  } catch {
    report.pdf_deps = 'missing';
    report.warnings.push({
      error: 'pdf_deps_missing',
      message: 'PDF output unavailable; analysis still works.',
      fix: 'npm install',
    });
  }

  const { cacheStats } = await import('./lib/cache.mjs');
  report.cache = await cacheStats();

  report.ok = report.warnings.length === 0;
  out(report);
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'resolve') await cmdResolve(rest);
  else if (cmd === 'views') await cmdViews(rest);
  else if (cmd === 'report') await cmdReport(rest);
  else if (cmd === 'check') await cmdCheck(rest);
  else if (cmd === 'doctor') await cmdDoctor();
  else if (!cmd || cmd === '--help' || cmd === '-h') process.stdout.write(USAGE);
  else throw new WtError('unknown_command', `Unknown command "${cmd}".`, { fix: 'wt --help' });
} catch (e) {
  fail(e);
}

// node scripts/wt.mjs report --run  --pdf /Users/dmytro/product_ai/_output.pdf

