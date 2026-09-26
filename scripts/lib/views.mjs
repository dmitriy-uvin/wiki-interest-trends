// The `views` command: resolve -> fetch -> normalize -> summarize.
//
// stdout stays small (a few dozen lines) while the bulk lands in a run directory.
// That split is not cosmetic: two years of daily views for ONE article is ~106 KB
// and 731 points, roughly 30k tokens if it reached an agent's context. A six
// language comparison would blow a cheap model's budget before it said anything.
//
// v1 deliberately applies NO quality gating. Every measured language is reported
// with its number, its monthly shape, and enough context to see when the number
// is untrustworthy. The detectors that would reject a figure outright belong to
// the next iteration.

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { resolveTopic } from './resolve.mjs';
import { articleSeries, projectTotalsMonthly } from './aqs.mjs';
import { mapLimit } from './http.mjs';
import { completeMonthWindow, sinceToMonths, iso } from './dates.mjs';
import { monthlyRollup, compareBlocks, medianDaily, pct1 } from './series.mjs';
import { monthlySparkline } from './sparkline.mjs';
import { assess } from './quality.mjs';
import { getJson, NO_DATA } from './http.mjs';

const NOTICE =
  'Each result carries a confidence label with the reasons behind it. Do not quote ' +
  'figures from a low-confidence row as findings: a detected level shift means the ' +
  'article was renamed or merged, not that interest changed. Always report the ' +
  'resolved article title alongside any number.';

/**
 * A month's topic views expressed per million of that project's total traffic.
 * Returned as nulls when the denominator is unknown, so the chart can leave a
 * gap rather than draw a misleading zero.
 */
function normalizeMonth(m, projectMonths) {
  const total = projectMonths?.[m.month];
  if (!total || !m.complete) return { project_views: total ?? null, per_million: null };
  return { project_views: total, per_million: +((m.views / total) * 1e6).toFixed(4) };
}

/**
 * When a level shift is detected, go and ask Wikipedia what happened rather
 * than guessing. Move and deletion logs plus the edit count in the surrounding
 * months turn "looks like a rename" into either evidence or its absence.
 *
 * This matters because the obvious explanation is often wrong. The Spanish
 * "gold mining" collapse has no move log, no deletion log and no edits at all
 * during the drop, and all-agents traffic fell with it -- so it is neither a
 * rename nor a bot reclassification, whatever the shape suggests.
 */
async function verifyChangepoint(lang, title, month) {
  const api = `https://${lang}.wikipedia.org/w/api.php`;
  const q = (o) => new URLSearchParams({ format: 'json', formatversion: '2', ...o }).toString();
  const from = `${month.slice(0, 4)}-${month.slice(4, 6)}-01T00:00:00Z`;
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() - 2);
  const start = d.toISOString();
  d.setUTCMonth(d.getUTCMonth() + 4);
  const end = d.toISOString();

  try {
    const [logs, revs] = await Promise.all([
      getJson(`${api}?${q({ action: 'query', list: 'logevents', letitle: title, lelimit: '20' })}`),
      getJson(
        `${api}?${q({
          action: 'query', prop: 'revisions', titles: title, rvlimit: '50',
          rvprop: 'timestamp|size', rvstart: start, rvend: end, rvdir: 'newer',
        })}`,
      ),
    ]);
    const events = (logs === NO_DATA ? [] : (logs?.query?.logevents ?? [])).filter(
      (e) => e.timestamp >= start && e.timestamp <= end,
    );
    const edits = revs === NO_DATA ? [] : (revs?.query?.pages?.[0]?.revisions ?? []);

    if (events.length) {
      const kinds = [...new Set(events.map((e) => `${e.type}/${e.action}`))].join(', ');
      return `Wikipedia logs show ${events.length} event(s) around then (${kinds}), which may explain the break`;
    }
    if (!edits.length) {
      return 'No move, deletion or edit activity around that month, so the break is not an article-side change';
    }
    return `No move or deletion logged; ${edits.length} ordinary edit(s) around that month`;
  } catch {
    return null; // verification is a bonus, never a reason to fail the run
  }
}

function newRunId() {
  const now = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDhhmmss
  return `r_${now}_${randomBytes(3).toString('hex')}`;
}

export function runDir(runId, base) {
  return path.join(base ?? process.env.WT_OUT_DIR ?? path.join(process.cwd(), 'wt-out'), 'runs', runId);
}

export async function runViews(
  topic,
  langs,
  { since = '2y', fromLang = 'en', verify = true, allowFold = false, write = true, outBase } = {},
) {
  const months = sinceToMonths(since);
  if (months < 2) throw new Error('Window too short; use at least 2 months.');
  const win = completeMonthWindow(months);

  const resolution = await resolveTopic(topic, langs, { fromLang, verify, allowFold });

  // One fetch per measurable language, plus that project's totals for the
  // normalization denominator. Bounded concurrency keeps us polite.
  const measured = await mapLimit(resolution.resolved, 4, async (r) => {
    const [series, totals] = await Promise.all([
      articleSeries({ project: r.project, title: r.title, from: win.from, to: win.to }),
      projectTotalsMonthly({ project: r.project, from: win.from, to: win.to }),
    ]);
    const monthly = monthlyRollup(series.series);
    const comparison = compareBlocks(monthly, totals.months, Math.floor(months / 2));
    let quality = assess({
      series: series.series,
      monthly,
      comparison,
      medianDaily: medianDaily(series.series, 90),
    });
    // A detected break is worth one extra request to explain.
    if (quality.signals.changepoint) {
      const note = await verifyChangepoint(r.lang, r.title, quality.signals.changepoint.month);
      if (note) {
        quality.signals.changepoint.log_check = note;
        quality = assess({
          series: series.series,
          monthly,
          comparison,
          medianDaily: medianDaily(series.series, 90),
          changepointNote: note,
        });
        quality.signals.changepoint.log_check = note;
      }
    }
    return { meta: r, series, monthly, totals, comparison, quality };
  });

  const results = measured.map(({ meta, series, monthly, comparison, quality }) => {
    const row = {
      lang: meta.lang,
      title: meta.title,
      ...(meta.warning && { warning: meta.warning }),
      ...(meta.redirected_from && { redirected_from: meta.redirected_from }),
      median_daily_90d: medianDaily(series.series, 90),
      days_missing: series.days_missing,
      sparkline: monthlySparkline(monthly),
      confidence: quality.confidence,
      confidence_score: quality.score,
      ...(quality.reasons.length && { confidence_reasons: quality.reasons.map((r) => r.detail) }),
      signals: quality.signals,
    };
    if (comparison.insufficient_history) {
      row.insufficient_history = {
        months_available: comparison.months_available,
        months_required: comparison.months_required,
      };
      return row;
    }
    row.raw = { ...comparison.raw, yoy_pct: pct1(comparison.raw.yoy_pct) };
    row.normalized = comparison.normalized.unavailable
      ? comparison.normalized
      : { ...comparison.normalized, yoy_pct: pct1(comparison.normalized.yoy_pct) };
    return row;
  });

  // A topic can resolve to a real but thinly-covered Wikidata item: "English
  // language learning" matches Q130192, which has 16 sitelinks and none for
  // pl/cs/uk/hu/ro. Returning five gaps and nothing else leaves an agent stuck,
  // so say explicitly what to try next.
  const hint =
    results.length === 0 && resolution.unresolved.length
      ? {
          problem: `"${topic}" resolved to ${resolution.entity.qid} (${resolution.entity.label ?? '?'}), which has no article in any requested language.`,
          try: [
            'Use a broader phrase for the same idea (e.g. "English language" instead of "English language learning").',
            ...(resolution.other_candidates?.length
              ? [`Try another sense of the topic: ${resolution.other_candidates.map((c) => c.title).join(', ')}.`]
              : []),
            `Resolve in a target language instead of English: --from ${langs[0]}`,
            'Run `wt resolve` with the same arguments to inspect the mapping without fetching data.',
          ],
        }
      : null;

  const runId = newRunId();
  const summary = {
    run_id: runId,
    topic,
    entity: resolution.entity,
    ...(resolution.other_candidates && { other_candidates: resolution.other_candidates }),
    window: { from: iso(win.from), to: iso(win.to), complete_months: months },
    notice: NOTICE,
    results,
    unresolved: resolution.unresolved,
    ...(hint && { hint }),
  };

  if (write) {
    const dir = runDir(runId, outBase);
    await mkdir(path.join(dir, 'series'), { recursive: true });
    await Promise.all([
      writeFile(path.join(dir, 'analysis.json'), JSON.stringify(summary, null, 2), 'utf8'),
      writeFile(
        path.join(dir, 'input.json'),
        JSON.stringify({ topic, langs, since, fromLang, verify, allowFold, window: win }, null, 2),
        'utf8',
      ),
      // Daily and monthly go in separate files. `wt report` reads these back, so a
      // PDF for an existing run costs no API calls at all.
      ...measured.flatMap(({ meta, series, monthly, totals }) => [
        writeFile(
          path.join(dir, 'series', `${meta.lang}.daily.ndjson`),
          series.series.map((p) => JSON.stringify(p)).join('\n') + '\n',
          'utf8',
        ),
        writeFile(
          path.join(dir, 'series', `${meta.lang}.monthly.ndjson`),
          monthly
            .map((m) => JSON.stringify({ ...m, ...normalizeMonth(m, totals.months) }))
            .join('\n') + '\n',
          'utf8',
        ),
      ]),
    ]);
    summary.artifacts = { dir, analysis: path.join(dir, 'analysis.json') };
  }

  return summary;
}

/**
 * Display width in terminal cells. CJK and fullwidth characters occupy two
 * cells but count as one JS character, so naive padEnd misaligns any table
 * containing a Chinese, Japanese or Korean article title.
 */
function displayWidth(str) {
  let w = 0;
  for (const ch of String(str)) {
    const c = ch.codePointAt(0);
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1f64f);
    w += wide ? 2 : 1;
  }
  return w;
}

const padTo = (str, width) => str + ' '.repeat(Math.max(0, width - displayWidth(str)));

/** Truncate by display width, not character count. */
function clip(str, max) {
  if (displayWidth(str) <= max) return str;
  let out = '';
  for (const ch of str) {
    if (displayWidth(out + ch) > max - 1) break;
    out += ch;
  }
  return out + '\u2026';
}

/** Fixed-width table for human eyes. The JSON is what agents read. */
export function renderTable(summary) {
  const lines = [];
  const e = summary.entity;
  lines.push(`${summary.topic}  [${e.qid} ${e.label ?? ''}]  ${summary.window.from} .. ${summary.window.to}`);
  lines.push('');
  // med/day is here because without it a model wanting audience size has nothing
  // to quote and makes one up: Haiku reported Polish at "~450 views/day" against
  // an actual 248.5. Any field the JSON carries and the table drops is a field
  // something will invent.
  const head = ['lang', 'article', 'prior', 'recent', 'med/day', 'raw', 'norm', 'conf', 'shape'];
  const rows = summary.results.map((r) => [
    r.lang,
    clip(r.title, 28),
    r.insufficient_history ? '-' : String(r.raw.prior),
    r.insufficient_history ? '-' : String(r.raw.recent),
    String(r.median_daily_90d ?? '-'),
    r.insufficient_history ? 'n/a' : `${r.raw.yoy_pct > 0 ? '+' : ''}${r.raw.yoy_pct}%`,
    r.insufficient_history || r.normalized.unavailable
      ? 'n/a'
      : `${r.normalized.yoy_pct > 0 ? '+' : ''}${r.normalized.yoy_pct}%`,
    (r.confidence ?? '-').toUpperCase(),
    r.sparkline,
  ]);
  const w = head.map((h, i) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i]))));
  const fmtRow = (cells) => cells.map((c, i) => padTo(String(c), w[i] + 2)).join('').trimEnd();
  lines.push(fmtRow(head));
  lines.push(w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of rows) lines.push(fmtRow(r));
  // Without these the table silently bypassed the whole quality layer: a LOW row
  // looked identical to a HIGH one, and a model reading it had no way to know.
  for (const r of summary.results) {
    for (const reason of r.confidence_reasons ?? []) lines.push(`  ${r.lang}: ${reason}`);
  }
  for (const u of summary.unresolved) lines.push(`gap   ${u.lang}: ${u.reason} - ${u.detail}`);
  if (summary.hint) {
    lines.push('');
    lines.push(`NOTHING MEASURABLE: ${summary.hint.problem}`);
    for (const t of summary.hint.try) lines.push(`  try: ${t}`);
  }
  lines.push('');
  lines.push(`raw = year-over-year on raw counts; norm = per million project views`);
  return lines.join('\n');
}
