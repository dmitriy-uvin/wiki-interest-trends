// Pure helpers for the eval harness, separated from run.mjs so they can be
// unit-tested without making network calls or running the CLI.

import { looksLikeSentence } from '../scripts/lib/resolve.mjs';
import { untraceableNumbers } from '../scripts/lib/claims.mjs';

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

// The traceability check lives in scripts/lib/claims.mjs, because it ships as a
// product feature (`wt check`, and the --notes gate on the PDF). Re-exported here
// so this harness scores the gate users actually get, not a second copy of it.
export { untraceableNumbers };

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
