// The log check behind a detected level shift.
//
// This path went untested for a while for a mundane reason: every article the
// suite covered had an empty move log, so only the negative branch ever ran. A
// verdict that has never returned its positive value is a verdict you cannot
// rely on, and this one decides which of two very different sentences a report
// carries.
//
// Offline, against recorded fixtures (`npm run record-fixtures`).

process.env.WT_FIXTURES = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyChangepoint } from '../scripts/lib/views.mjs';

test('a logged page move is reported as an article event', async () => {
  // en "X (social network)": 2,043 -> 263,525 views/month at 202603, because the
  // article was moved onto that title. Nothing about interest changed.
  const r = await verifyChangepoint('en', 'X (social network)', '202603');
  assert.equal(r.cause, 'article_event');
  assert.match(r.detail, /Wikipedia logs show/);
  assert.match(r.detail, /move/);
});

test('an absence of any activity is reported as such, not as a rename', async () => {
  // es "Minería del oro": 1,982 -> 238/month at 202505 with no move, no deletion
  // and no edits. The drop is real and unexplained; calling it a rename would be
  // inventing a cause.
  const r = await verifyChangepoint('es', 'Minería del oro', '202505');
  assert.equal(r.cause, 'no_activity');
  assert.match(r.detail, /No move, deletion or edit activity/);
});

test('a failed check returns null rather than failing the run', async () => {
  // No fixture exists for this title, so the request throws. Verification is a
  // bonus: the measurement it annotates is already complete.
  const r = await verifyChangepoint('en', 'Nonexistent article for this test', '202601');
  assert.equal(r, null);
});
