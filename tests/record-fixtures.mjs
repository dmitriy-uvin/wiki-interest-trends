#!/usr/bin/env node
// Re-record the HTTP fixtures the offline test suite reads.
//
// Fixtures are keyed by request URL, so any change to a request -- a new
// parameter, a different limit -- orphans its recording and the affected tests
// fail with `fixture_missing`. Re-run this, review the diff, commit.
//
//   WT_CONTACT="you@example.com" node tests/record-fixtures.mjs
//
// It needs network and makes real API calls. Everything else in the suite is
// offline; this is the only script that is not.

process.env.WT_RECORD = '1';
delete process.env.WT_FIXTURES;

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTopic, findEntity } from '../scripts/lib/resolve.mjs';
import { verifyChangepoint } from '../scripts/lib/views.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANGS = ['en', 'de', 'fr', 'es', 'pl'];

// tests/resolve.test.mjs
await findEntity('gold mining');
await resolveTopic('gold mining', LANGS);
await resolveTopic('gold mining', LANGS, { allowFold: true });
await resolveTopic('intermittent fasting', ['pl', 'cs']);
process.stdout.write('recorded: resolve suite\n');

// tests/golden.test.mjs — one entity lookup per listed topic
const golden = (await readFile(path.join(HERE, 'golden-topics.jsonl'), 'utf8'))
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
for (const g of golden) {
  await resolveTopic(g.topic, ['en'], { verify: false });
  process.stdout.write(`recorded: ${g.topic}\n`);
}

// tests/changepoint.test.mjs — the log check, in all three verdicts.
// en "X (social network)" rises 128.9x at 202603 with move/move logged; es
// "Minería del oro" falls 8.3x at 202505 with nothing logged at all.
await verifyChangepoint('en', 'X (social network)', '202603');
await verifyChangepoint('es', 'Minería del oro', '202505');
process.stdout.write('recorded: changepoint log checks\n');
