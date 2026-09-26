// Pure helpers for the eval harness, separated from run.mjs so they can be
// unit-tested without making network calls or running the CLI.

import { looksLikeSentence } from '../scripts/lib/resolve.mjs';

/**
 * The quoted topic argument of each `views`/`resolve` command.
 * Extraction is the model's job and lives entirely in SKILL.md, so this is the
 * only way to test whether the model actually did it.
 */
export function topicsIn(commands) {
  const out = [];
  for (const c of commands) {
    const m = /\b(?:views|resolve)\s+("([^"]*)"|'([^']*)'|[^\s-][^\s]*)/.exec(c);
    if (m) out.push(m[2] ?? m[3] ?? m[1]);
  }
  return out;
}

/** Only this skill's own CLI may be executed by the harness. */
export const ALLOWED = /^node\s+scripts\/wt\.mjs\s/;

/** Pull shell commands out of fenced code blocks in a model reply. */
export function extractCommands(text) {
  const out = [];
  const fence = /```(?:bash|sh|shell)?\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(text))) {
    for (const line of m[1].split('\n')) {
      const cmd = line.trim();
      if (cmd && !cmd.startsWith('#')) out.push(cmd);
    }
  }
  return out;
}

/** Split a command line into argv, keeping quoted topics intact. */
export const toArgv = (cmd) => (cmd.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^["']|["']$/g, ''));

/**
 * Compile a scenario pattern. Checks are case-insensitive, and a `(?i)` prefix
 * is tolerated and stripped: JavaScript has no inline flag syntax, and scenario
 * files are easier to write if that detail does not matter.
 */
export const compile = (p) => new RegExp(String(p).replace(/\(\?i\)/g, ''), 'i');
export const allMatch = (patterns, text) => (patterns ?? []).filter((p) => !compile(p).test(text));
export const anyMatch = (patterns, text) => (patterns ?? []).filter((p) => compile(p).test(text));

/**
 * Numbers in the answer that never appeared in any command output.
 *
 * This is the anti-hallucination check and the reason the harness exists: prose
 * can be persuasive, but an invented figure is detectable. Small integers,
 * years, and values the model rounded for readability are ignored, so this
 * flags invention rather than paraphrase.
 */
export function untraceableNumbers(answer, toolOutput, reference = '') {
  // Compare NUMERICALLY, never as substrings. Substring matching silently
  // accepts invented figures: "63" occurs inside "40630", so a fabricated 62.5%
  // would look traceable against any output containing that count.
  const NUM = /-?\d[\d,]*(?:\.\d+)?/g;
  const parse = (t) => (String(t).match(NUM) ?? []).map((x) => parseFloat(x.replace(/,/g, ''))).filter(Number.isFinite);

  // SKILL.md states figures of its own (the per-edition traffic decline rates),
  // and a model quoting those is citing documentation, not inventing.
  const shown = [...parse(toolOutput), ...parse(reference)];
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

/** Score one finished transcript against a scenario's checks. */
export function score(sc, { commands, answer, toolOutput, reference = '' }) {
  const missedCalls = allMatch(sc.must_call, commands.join('\n'));
  const missedMentions = allMatch(sc.must_mention, answer);
  const forbidden = anyMatch(sc.must_not_mention, answer);
  const invented = untraceableNumbers(answer, toolOutput, reference);
  // A model that pipes the user's question straight through as the topic gets a
  // real article back (Wikipedia search always returns something), so no other
  // check catches it. This does.
  const sentenceTopics = topicsIn(commands).filter(looksLikeSentence);
  const checks = {
    ran_a_command: commands.length > 0,
    correct_commands: missedCalls.length === 0,
    required_content: missedMentions.length === 0,
    avoided_wrong_claims: forbidden.length === 0,
    numbers_traceable: invented.length === 0,
    topic_extracted: sentenceTopics.length === 0,
  };
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    sentence_topics: sentenceTopics,
    missed_calls: missedCalls,
    missed_mentions: missedMentions,
    forbidden_matches: forbidden,
    invented_numbers: invented,
  };
}
