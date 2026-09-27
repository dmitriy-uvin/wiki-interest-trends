// Task 4b — checking the agent's prose against the run it came from.
//
// quality.mjs decides whether a FIGURE is safe to quote. Nothing decided whether
// the SENTENCE quoting it is faithful to the data, and those are different
// failures: a real number attached to the wrong language, or to the wrong
// direction, reads exactly as well as a right one.
//
// Everything here is a pure function over analysis.json plus a block of text. No
// API calls, no model in the loop -- a judge that shared the generator's blind
// spots would be worth nothing. One implementation serves three callers (the
// `wt check` command, the --notes gate in report.mjs, and the eval harness), so
// the eval measures the gate that actually ships rather than a copy of it.
//
// Scope, stated plainly because overselling this check would be worse than not
// having it: it reads figures, signs and language attribution. It cannot judge
// whether a claim with no number in it is true.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Numbers the skill's own documentation states, which a model may therefore
// quote without inventing: the per-edition traffic decline rates in SKILL.md
// (-7%/year en, -25%/year uk) and the per-million normalization unit.
const DOC_FIGURES = [7, 25, 1e6];

/** The reader-facing name of a language code. The PDF renders the same string. */
export const langName = (code) => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
};

const NUM = /-?\d[\d,]*(?:\.\d+)?/g;
const parseNums = (t) =>
  (String(t).match(NUM) ?? []).map((x) => parseFloat(x.replace(/,/g, ''))).filter(Number.isFinite);

/**
 * Numbers in the answer that never appeared in any command output.
 *
 * This is the anti-hallucination check: prose can be persuasive, but an invented
 * figure is detectable. Small integers, years, and values the model rounded for
 * readability are ignored, so this flags invention rather than paraphrase.
 */
export function untraceableNumbers(answer, toolOutput, reference = '') {
  // Compare NUMERICALLY, never as substrings. Substring matching silently
  // accepts invented figures: "63" occurs inside "40630", so a fabricated 62.5%
  // would look traceable against any output containing that count.
  const shown = [...parseNums(toolOutput), ...parseNums(reference)];
  const shownForms = new Set();
  for (const o of shown) {
    for (const v of [o, Math.abs(o), Math.round(o), Math.abs(Math.round(o)), +o.toFixed(1), Math.abs(+o.toFixed(1))]) {
      shownForms.add(v);
    }
  }

  const bad = [];
  for (const raw of String(answer).match(NUM) ?? []) {
    const v = parseFloat(raw.replace(/,/g, ''));
    if (!Number.isFinite(v)) continue;
    const a = Math.abs(v);
    if (a <= 24 && Number.isInteger(a)) continue; // counts, month spans, list numbering
    if (Number.isInteger(a) && a >= 1900 && a <= 2100) continue; // years
    if (shownForms.has(v) || shownForms.has(a)) continue;
    // The model may round a shown figure for readability.
    // Two tolerances, both for rounding rather than invention:
    //   absolute <= 0.5, because the tool reports 248.5 and "248" is correct
    //     (the strict < form failed exactly on the .5 boundary, which is where
    //     rounding happens);
    //   relative 2% above 100, because "~240" for 238 is ordinary prose.
    // Neither hides a real error: a claimed 450 against an actual 248.5 is 81%
    // out and still flagged.
    if (shown.some((o) => Math.abs(Math.abs(o) - a) <= 0.5 && a >= 1)) continue;
    if (a >= 100 && shown.some((o) => Math.abs(Math.abs(o) - a) / a <= 0.02)) continue;
    bad.push(raw);
  }
  return [...new Set(bad)];
}

/** Does `a` match any of `shown`, under the same rounding tolerances? */
const matches = (a, shown) =>
  shown.some((o) => {
    const b = Math.abs(o);
    return b === a || Math.round(b) === Math.round(a) || Math.abs(b - a) <= 0.5 || (a >= 100 && Math.abs(b - a) / a <= 0.02);
  });

/** Every number appearing anywhere in a JSON value. */
const numbersIn = (value) => parseNums(JSON.stringify(value ?? null));

// Sentence is the attribution unit: it is the smallest span where "Ukrainian"
// and "21 views/day" are plausibly about each other. Bullets and line breaks
// count as boundaries, because agent prose is usually a list.
const sentences = (text) =>
  String(text)
    .split(/(?<=[.!?;:])\s+|\n+|(?:^|\s)[-*•]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

// Two-letter codes that are also ordinary English words. "it is growing" must
// not bind a sentence to Italian, so for these the code only counts when it is
// written the way a code is written: it.wikipedia, (it), it:, or uppercase.
const WORD_CODES = new Set(['it', 'no', 'is', 'be', 'am', 'as', 'at', 'or', 'to', 'so', 'an', 'in', 'my', 'we', 'he', 'la', 'na', 'ha']);

function codePattern(code) {
  const c = code.replace(/[^a-z-]/gi, '');
  if (!c) return null;
  if (WORD_CODES.has(c)) return new RegExp(`(?:\\b${c}\\.wikipedia\\b|\\(${c}\\)|\\b${c}:|\\b${c.toUpperCase()}\\b)`);
  return new RegExp(`(?:^|[^a-z])${c}(?![a-z])`, 'i');
}

/**
 * Titles that identify an edition, as opposed to titles that merely repeat the
 * topic. The English article for "Mars" is called *Mars*, so treating every
 * sentence that names the topic as a sentence about the `en` row bound most
 * sentences to two editions at once -- which switched attribution off silently,
 * because attribution needs a single subject. A title only counts as evidence
 * when it says something the topic phrase does not.
 */
function distinguishingTitles(analysis) {
  const generic = [analysis?.topic, analysis?.entity?.label]
    .filter(Boolean)
    .map((t) => String(t).toLowerCase());
  const out = new Map();
  for (const r of analysis?.results ?? []) {
    const t = String(r.title ?? '').toLowerCase();
    if (!t) continue;
    if (generic.some((g) => g === t || g.includes(t) || t.includes(g))) continue;
    out.set(r.lang, r.title);
  }
  return out;
}

/** Which measured rows a sentence is talking about: by code, by name, or by title. */
function rowsReferenced(sentence, rows, titles) {
  return rows.filter((r) => {
    const code = codePattern(r.lang);
    if (code?.test(sentence)) return true;
    const name = langName(r.lang);
    if (name !== r.lang && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(sentence)) return true;
    const title = titles.get(r.lang);
    return Boolean(title) && sentence.includes(title);
  });
}

const GROWTH = /\b(grew|grow\w*|rose|ris\w*|increas\w*|gain\w*|climb\w*|surg\w*|up\b|higher|expand\w*)\b/i;
const DECLINE = /\b(fell|fall\w*|declin\w*|drop\w*|decreas\w*|lost|loss|shrank|shrink\w*|slid|slipp\w*|collaps\w*|down\b|lower)\b/i;

// A cue that the sentence is hedging rather than presenting the figure as a
// finding. Deliberately generous: the failure mode to avoid is blocking a
// correct report, after which the agent stops using --notes altogether.
const CAUTION =
  /\b(low|noisy|noise|caution\w*|unreliable|uncertain\w*|not comparable|renam\w*|merg\w*|level (shift|drop|change|break)|break|confidence|too (little|few)|insufficient|tentative|indicative|treat\b|cannot|can't|not (enough|safe|a finding)|suppress\w*|exclude\w*)\b/i;

/**
 * Check a block of prose against one run.
 *
 * Severities are not cosmetic. `error` is reserved for the two failures that are
 * categorically wrong whatever the context -- a figure from nowhere, and a
 * figure quoted against its own sign -- because those gate the PDF. Attribution
 * and hedging are heuristics over English prose, so they warn.
 */
export function checkClaims(analysis, text, { reference = '' } = {}) {
  const rows = analysis?.results ?? [];
  const claims = String(text ?? '');

  // Everything the run printed, as the traceability corpus. analysis.json rather
  // than the session scrollback: it is exactly the figures the skill emitted,
  // and it survives a compacted context.
  const runNumbers = numbersIn(analysis);
  const issues = [];

  for (const raw of untraceableNumbers(claims, JSON.stringify(analysis), reference + ' ' + DOC_FIGURES.join(' '))) {
    issues.push({
      id: 'untraceable_figure',
      severity: 'error',
      figure: raw,
      detail: `${raw} appears nowhere in this run's data. Quote a figure from the command output, or run another command to get it.`,
    });
  }

  // Per-row number sets. `figures` is the quotable-finding subset (the period
  // comparison); `all` is everything the row printed, so a sentence may cite a
  // row's volume or confidence score without tripping attribution.
  const byLang = new Map(
    rows.map((r) => [
      r.lang,
      { row: r, figures: [...numbersIn(r.raw), ...numbersIn(r.normalized)], all: numbersIn(r) },
    ]),
  );
  const globalNumbers = numbersIn({ ...analysis, results: undefined, unresolved: undefined });
  const titles = distinguishingTitles(analysis);
  const shared = [...globalNumbers, ...DOC_FIGURES, ...parseNums(reference)];

  for (const sentence of sentences(claims)) {
    const refs = rowsReferenced(sentence, rows, titles);
    // A comparison sentence names two editions, so no figure in it can be
    // attributed to one of them. Attribution checks need exactly one subject.
    if (refs.length !== 1) continue;
    const { row, figures, all } = byLang.get(refs[0].lang);

    for (const token of sentence.match(NUM) ?? []) {
      const v = parseFloat(token.replace(/,/g, ''));
      if (!Number.isFinite(v)) continue;
      const a = Math.abs(v);
      if (a <= 24 && Number.isInteger(a)) continue;
      if (Number.isInteger(a) && a >= 1900 && a <= 2100) continue;
      if (matches(a, shared) || matches(a, all)) {
        // Sign. A -30.2% quoted as growth is the failure that survives every
        // number-only check, because the magnitude is real.
        for (const [field, yoy] of [
          ['raw', row.raw?.yoy_pct],
          ['normalized', row.normalized?.yoy_pct],
        ]) {
          if (yoy == null || !matches(a, [yoy])) continue;
          const signedDown = token.trimStart().startsWith('-');
          const saysGrowth = GROWTH.test(sentence) && !DECLINE.test(sentence);
          const saysDecline = DECLINE.test(sentence) && !GROWTH.test(sentence);
          if (yoy < 0 && saysGrowth && !signedDown) {
            issues.push({
              id: 'direction_conflict',
              severity: 'error',
              lang: row.lang,
              figure: token,
              detail: `${row.lang} ${field} year-over-year is ${yoy}% (a decline), but this sentence presents ${token} as growth: "${sentence}"`,
            });
          } else if (yoy > 0 && saysDecline && signedDown === false && !/\bnot\b/i.test(sentence)) {
            issues.push({
              id: 'direction_conflict',
              severity: 'error',
              lang: row.lang,
              figure: token,
              detail: `${row.lang} ${field} year-over-year is +${yoy}% (a rise), but this sentence presents ${token} as a decline: "${sentence}"`,
            });
          }
        }

        // Hard rule 4: a low-confidence figure is not a finding. Quoting one is
        // allowed when the sentence says why it is shaky.
        if (row.confidence === 'low' && matches(a, figures) && !CAUTION.test(sentence)) {
          issues.push({
            id: 'low_confidence_quoted',
            severity: 'warning',
            lang: row.lang,
            figure: token,
            detail:
              `${row.lang} is rated LOW confidence, and ${token} is quoted here with no caveat: "${sentence}". ` +
              `Report the reason instead: ${(row.confidence_reasons ?? []).join('; ') || 'see confidence_reasons'}`,
          });
        }
        continue;
      }

      // Traceable to the run, but to a different edition's row. Silent and
      // plausible: the number is real, the subject is wrong.
      const owners = [...byLang.values()].filter((o) => matches(a, o.all)).map((o) => o.row.lang);
      if (owners.length) {
        issues.push({
          id: 'misattributed_figure',
          severity: 'warning',
          lang: row.lang,
          figure: token,
          detail: `${token} belongs to ${owners.join(', ')}, not to ${row.lang}: "${sentence}"`,
        });
      }
    }
  }

  const errors = issues.filter((i) => i.severity === 'error');
  return {
    ok: errors.length === 0,
    checked: { figures_in_run: runNumbers.length, languages: rows.map((r) => r.lang), sentences: sentences(claims).length },
    errors,
    warnings: issues.filter((i) => i.severity === 'warning'),
  };
}

/** analysis.json on its own, without pulling in the PDF machinery. */
export async function loadAnalysis(dir) {
  return JSON.parse(await readFile(path.join(dir, 'analysis.json'), 'utf8'));
}
