// Checking prose against a run. The fixture is a real shape from wt-out: two
// measured editions with opposite signs, one of them LOW confidence.
//
// The expensive mistake here is a FALSE POSITIVE. An error blocks the PDF, and a
// gate that rejects a correct report teaches the agent to stop using --notes, so
// most of these cases pin the clean direction: ordinary, accurate prose must
// pass untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkClaims, untraceableNumbers } from '../scripts/lib/claims.mjs';

const analysis = {
  run_id: 'r_test',
  topic: 'gold mining',
  entity: { qid: 'Q1071389', label: 'gold mining' },
  window: { from: '2024-09-01', to: '2026-08-31', complete_months: 24 },
  results: [
    {
      lang: 'ru',
      title: 'Золотодобыча',
      median_daily_90d: 58,
      confidence: 'high',
      raw: { prior: 40630, recent: 24267, yoy_pct: -40.3 },
      normalized: { prior: 4.07, recent: 3.1, yoy_pct: -23.7 },
    },
    {
      lang: 'tr',
      title: 'Altın madenciliği',
      median_daily_90d: 3,
      confidence: 'low',
      confidence_reasons: ['median 3 views/day — a percentage on this much traffic is mostly noise'],
      raw: { prior: 838, recent: 1349, yoy_pct: 61.0 },
      normalized: { prior: 0.31, recent: 0.6, yoy_pct: 92.4 },
    },
  ],
  unresolved: [{ lang: 'pl', reason: 'no_article' }],
};

const ids = (r) => [...r.errors, ...r.warnings].map((i) => i.id);

test('accurate prose passes with nothing flagged', () => {
  const r = checkClaims(
    analysis,
    'Russian interest fell 23.7% normalized over the window, from 4.07 to 3.1 views per million. ' +
      'Turkish is rated low confidence at 3 views/day, so its 92.4% is noise rather than a finding.',
  );
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.ok, true);
});

test('an invented figure is an error', () => {
  const r = checkClaims(analysis, 'Russian interest fell 62.5% over the window.');
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].id, 'untraceable_figure');
  assert.equal(r.errors[0].figure, '62.5');
});

test('a real magnitude quoted against its own sign is an error', () => {
  const r = checkClaims(analysis, 'Russian grew 23.7% year over year, so the market is expanding.');
  assert.equal(r.ok, false);
  const e = r.errors.find((i) => i.id === 'direction_conflict');
  assert.ok(e, 'a -23.7% reported as growth must be caught');
  assert.equal(e.lang, 'ru');
});

test('the same figure written as a decline passes, in either notation', () => {
  for (const s of ['Russian fell 23.7% year over year.', 'Russian is down 23.7%.', 'Russian: -23.7% year over year.']) {
    assert.deepEqual(checkClaims(analysis, s).errors, [], s);
  }
});

test("a figure from another edition's row is flagged, not silently accepted", () => {
  const r = checkClaims(analysis, 'Turkish interest fell 40.3% over the window.');
  const w = r.warnings.find((i) => i.id === 'misattributed_figure');
  assert.ok(w, '40.3 belongs to ru');
  assert.match(w.detail, /belongs to ru/);
  assert.equal(r.ok, true, 'attribution is a heuristic over prose, so it warns rather than blocking');
});

test('a low-confidence figure quoted bare warns; the same figure hedged does not', () => {
  const bare = checkClaims(analysis, 'Turkish grew 92.4% normalized, the strongest of the two.');
  assert.ok(bare.warnings.some((i) => i.id === 'low_confidence_quoted'));

  const hedged = checkClaims(analysis, 'Turkish shows 92.4% but is rated low confidence on 3 views/day, so treat it as noise.');
  assert.ok(!ids(hedged).includes('low_confidence_quoted'));
});

test('a comparison sentence is not attributed to either edition', () => {
  // Both languages are named, so no figure in the sentence has a single subject.
  const r = checkClaims(analysis, 'Russian fell 23.7% while Turkish rose 92.4%.');
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.errors, []);
});

test('English words that happen to be language codes do not bind a sentence', () => {
  // "it", "no", "is" are Italian, Norwegian and Icelandic. A sentence about
  // Russian that contains them must stay attributed to Russian only.
  const withCodeWords = {
    ...analysis,
    results: [...analysis.results, { lang: 'it', title: 'Attività estrattiva', confidence: 'high', raw: { yoy_pct: 5.5 }, normalized: { yoy_pct: 7.7 } }],
  };
  const r = checkClaims(withCodeWords, 'Russian fell 23.7%, and it is no longer growing.');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test("an edition whose article title IS the topic does not capture every sentence", () => {
  // Real failure, found end-to-end on the Mars run: the English article for Mars
  // is called "Mars", so naming the topic bound the sentence to `en` as well as
  // to its actual subject, and two subjects switch attribution off entirely.
  const marsish = {
    ...analysis,
    topic: 'gold mining',
    results: [{ ...analysis.results[0] }, { ...analysis.results[1], lang: 'en', title: 'gold mining' }],
  };
  const r = checkClaims(marsish, 'Russian interest in gold mining grew 23.7% year over year.');
  assert.equal(r.ok, false, 'the sentence is about ru alone, so the sign check must still run');
  assert.equal(r.errors[0].id, 'direction_conflict');
});

test('window figures and documented rates are not treated as invented', () => {
  const r = checkClaims(
    analysis,
    'Measured over 24 complete months to 2026-08-31. Ukrainian Wikipedia loses about 25% of its human traffic a year, ' +
      'which is why normalized figures are quoted.',
  );
  assert.deepEqual(r.errors, []);
});

test('the traceability primitive keeps its rounding tolerances', () => {
  const output = JSON.stringify(analysis);
  assert.deepEqual(untraceableNumbers('Views went from 40,630 to 24,267.', output), [], 'thousands separators');
  assert.deepEqual(untraceableNumbers('It declined about 40% year over year.', output), [], 'rounded for prose');
  assert.deepEqual(untraceableNumbers('Interest fell by 62.5%.', output), ['62.5']);
});
