// Topic -> Wikidata entity, pinned.
//
// Resolution is where a wrong answer is least visible: a mis-resolved topic
// produces a clean, high-confidence series measuring something else entirely.
// Nothing downstream can catch it, so the expected values here were checked by
// hand against each item's Wikidata label and description -- the `means` field is
// that check, kept in the file so a future reader can repeat it.
//
// Offline, against recorded fixtures (`npm run record-fixtures`). If a case fails
// after a re-record, Wikipedia changed and the expectation needs a human decision,
// not a quick edit.

process.env.WT_FIXTURES = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTopic } from '../scripts/lib/resolve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cases = (await readFile(path.join(HERE, 'golden-topics.jsonl'), 'utf8'))
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

test('the golden set is not empty and covers both directions', () => {
  assert.ok(cases.length >= 10);
  assert.ok(cases.some((c) => c.confidence === 'high' && (c.senses ?? []).length === 0), 'needs clean controls');
  assert.ok(cases.some((c) => (c.senses ?? []).length > 0), 'needs ambiguous cases');
  assert.ok(cases.some((c) => c.confidence === 'low'), 'needs non-topic queries');
});

for (const c of cases) {
  test(`resolves "${c.topic}" — ${c.means}`, async () => {
    const r = await resolveTopic(c.topic, ['en'], { verify: false });
    const e = r.entity;

    if (c.qid) assert.equal(e.qid, c.qid, `expected ${c.qid} (${c.means}), got ${e.qid} (${e.description ?? '?'})`);
    assert.equal(e.confidence, c.confidence, `confidence for "${c.topic}"${e.why ? ` — ${e.why}` : ''}`);

    const senses = (e.other_senses ?? []).map((x) => x.qid);
    for (const want of c.senses ?? []) {
      assert.ok(senses.includes(want), `"${c.topic}" must offer ${want} as another sense; got ${senses.join(', ') || 'none'}`);
    }
    if ((c.senses ?? []).length === 0 && c.confidence === 'high') {
      assert.equal(senses.length, 0, `"${c.topic}" must not invent rival senses; got ${senses.join(', ')}`);
    }
  });
}
