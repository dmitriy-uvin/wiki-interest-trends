// Tests for the eval harness itself. If the scorer is wrong, every number it
// reports about the skill is worthless, so it gets the same scrutiny as the
// skill's own logic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractCommands, toArgv, ALLOWED, compile, score, untraceableNumbers, topicsIn } from '../evals/lib.mjs';
import { looksLikeSentence } from '../scripts/lib/resolve.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);

test('commands are pulled out of fenced blocks, comments ignored', () => {
  const reply = 'Let me check.\n\n```bash\n# first resolve\nnode scripts/wt.mjs resolve "gold mining" --langs de\n```\nthen\n```\nnode scripts/wt.mjs views "gold mining" --langs de\n```';
  assert.deepEqual(extractCommands(reply), [
    'node scripts/wt.mjs resolve "gold mining" --langs de',
    'node scripts/wt.mjs views "gold mining" --langs de',
  ]);
  assert.deepEqual(extractCommands('no code here'), []);
});

test('quoted multi-word topics survive argv splitting', () => {
  assert.deepEqual(toArgv('node scripts/wt.mjs views "intermittent fasting" --langs pl,cs'), [
    'node', 'scripts/wt.mjs', 'views', 'intermittent fasting', '--langs', 'pl,cs',
  ]);
});

test('only the skill CLI may be executed', () => {
  assert.ok(ALLOWED.test('node scripts/wt.mjs views "x" --langs en'));
  assert.ok(!ALLOWED.test('rm -rf /'));
  assert.ok(!ALLOWED.test('curl https://example.com'));
  assert.ok(!ALLOWED.test('node evil.mjs'));
  assert.ok(!ALLOWED.test('cat ~/.ssh/id_rsa'));
});

test('patterns are case-insensitive and tolerate a (?i) prefix', () => {
  // JavaScript has no inline flag syntax; scenarios may still carry (?i).
  assert.ok(compile('(?i)czech').test('CZECH'));
  assert.ok(compile('czech').test('Czech'));
});

test('invented numbers are caught; quoted and rounded ones are not', () => {
  const output = '{"raw":{"prior":40630,"recent":24267,"yoy_pct":-40.3},"normalized":{"yoy_pct":-23.7}}';
  assert.deepEqual(untraceableNumbers('Russian fell 40.3% raw and 23.7% normalized.', output), []);
  assert.deepEqual(untraceableNumbers('Views went from 40,630 to 24,267.', output), [], 'thousands separators');
  assert.deepEqual(untraceableNumbers('It declined about 40% year over year.', output), [], 'rounded for prose');
  assert.deepEqual(untraceableNumbers('Interest fell by 62.5% since 2019.', output), ['62.5'], 'a figure never shown');
});

test('small integers and years are not treated as invented figures', () => {
  assert.deepEqual(untraceableNumbers('Across 12 languages over 2 years, since 2024.', 'nothing'), []);
});

test('the scorer fails a transcript that reports a gap as zero interest', async () => {
  const scenarios = (await readFile(path.join(HERE, '..', 'evals', 'scenarios.jsonl'), 'utf8'))
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const sc = scenarios.find((s) => s.id === 'brief-1-fasting');

  const bad = score(sc, {
    commands: ['node scripts/wt.mjs views "intermittent fasting" --langs pl,cs'],
    answer: 'Czech grew steadily. Polish shows 0 views, so there is no interest in Poland.',
    toolOutput: '{}',
  });
  assert.equal(bad.pass, false);
  assert.equal(bad.checks.avoided_wrong_claims, false, 'the "Polish = zero interest" claim must be caught');

  const good = score(sc, {
    commands: ['node scripts/wt.mjs views "intermittent fasting" --langs pl,cs'],
    answer:
      'Czech (cs) can be measured and is growing. Polish (pl) has no article for this concept at all, ' +
      'so it is a content gap rather than an absence of interest.',
    toolOutput: '{}',
  });
  assert.equal(good.pass, true, JSON.stringify(good));
});

test('the scorer fails a transcript that never ran a command', () => {
  const sc = { id: 'x', must_call: ['views'], must_mention: [], must_not_mention: [] };
  const r = score(sc, { commands: [], answer: 'Interest is probably growing.', toolOutput: '' });
  assert.equal(r.pass, false);
  assert.equal(r.checks.ran_a_command, false);
  assert.equal(r.checks.correct_commands, false);
});

test('every scenario has checks that could actually fail', async () => {
  const scenarios = (await readFile(path.join(HERE, '..', 'evals', 'scenarios.jsonl'), 'utf8'))
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(scenarios.length >= 8, 'at least 8 scenarios');
  for (const s of scenarios) {
    assert.ok(s.id && s.prompt, `${s.id} needs an id and prompt`);
    assert.ok((s.must_call ?? []).length > 0, `${s.id} must assert on commands`);
    assert.ok((s.must_mention ?? []).length > 0, `${s.id} must assert on content`);
    const empty = score(s, { commands: [], answer: '', toolOutput: '' });
    assert.equal(empty.pass, false, `${s.id} would pass on an empty transcript`);
  }
});

test('a model that passes the user\'s question through as the topic is caught', async () => {
  // Extraction happens in the model, guided only by SKILL.md, so this check is
  // the sole way to test it. No other check catches the failure: Wikipedia
  // search always returns SOME article, and `views.*astronom` matches a
  // sentence containing "astronomy" just as well as the bare topic.
  const scenarios = (await readFile(path.join(HERE, '..', 'evals', 'scenarios.jsonl'), 'utf8'))
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const sc = scenarios.find((s) => s.id === 'brief-2-astronomy');
  const answer = 'per million, normalized; limitation: curiosity not demand. uk';

  const lazy = score(sc, {
    commands: ['node scripts/wt.mjs views "is interest in astronomy growing in Ukrainian Wikipedia" --langs uk'],
    answer, toolOutput: '{}',
  });
  assert.equal(lazy.checks.topic_extracted, false);
  assert.equal(lazy.checks.correct_commands, true, 'the regex checks alone would have let this pass');
  assert.equal(lazy.pass, false);

  const good = score(sc, {
    commands: ['node scripts/wt.mjs views "astronomy" --langs uk --since 2y'],
    answer, toolOutput: '{}',
  });
  assert.equal(good.checks.topic_extracted, true);
  assert.equal(good.pass, true);
});

test('topics are parsed out of commands in either quote style', () => {
  assert.deepEqual(
    topicsIn([
      'node scripts/wt.mjs views "gold mining" --langs en',
      "node scripts/wt.mjs resolve 'intermittent fasting' --langs pl",
      'node scripts/wt.mjs doctor',
    ]),
    ['gold mining', 'intermittent fasting'],
  );
});

test('sentence detection counts raw words, not stopword-filtered tokens', () => {
  // "is interest in astronomy growing in Ukrainian Wikipedia" reduces to three
  // content words; filtering first would classify it as a topic.
  assert.equal(looksLikeSentence('is interest in astronomy growing in Ukrainian Wikipedia'), true);
  assert.equal(looksLikeSentence('how has gold mining interest changed?'), true);
  assert.equal(looksLikeSentence('gold mining'), false);
  assert.equal(looksLikeSentence('intermittent fasting diet'), false);
});
