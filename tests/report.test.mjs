// Page-2 data table: number abbreviation and period bucketing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abbrev, buildDataRows } from '../scripts/lib/report.mjs';

test('abbreviation is compact and correct at every boundary', () => {
  assert.equal(abbrev(0), '0');
  assert.equal(abbrev(261), '261');
  assert.equal(abbrev(999), '999');
  assert.equal(abbrev(1000), '1.0k');
  assert.equal(abbrev(8642), '8.6k');
  assert.equal(abbrev(9999), '10k', 'rounds up into the integer-k band');
  assert.equal(abbrev(192823), '193k');
  assert.equal(abbrev(999999), '1.0M', 'must not render as 1000k');
  assert.equal(abbrev(1200000), '1.2M');
  assert.equal(abbrev(null), '–');
  assert.equal(abbrev(undefined), '–');
});

/** n complete months of data for the given languages. */
const fixture = (langs, n, startYm = '202401') =>
  Object.fromEntries(
    langs.map((l) => [
      l,
      Array.from({ length: n }, (_, i) => {
        const d = new Date(Date.UTC(+startYm.slice(0, 4), +startYm.slice(4, 6) - 1 + i, 1));
        const month = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        return { month, views: 100 + i, complete: true };
      }),
    ]),
  );

const analysisFor = (langs) => ({ results: langs.map((lang) => ({ lang })) });

test('a two-year window stays monthly', () => {
  const langs = ['en', 'uk'];
  const { rows, quarterly } = buildDataRows(analysisFor(langs), fixture(langs, 24));
  assert.equal(quarterly, false);
  assert.equal(rows.length, 24);
  assert.equal(rows[0].label, '01.24');
  assert.equal(rows.at(-1).label, '12.25');
});

test('a long window switches to quarters rather than overflowing the page', () => {
  const langs = ['en'];
  const { rows, quarterly } = buildDataRows(analysisFor(langs), fixture(langs, 84)); // 7 years
  assert.equal(quarterly, true);
  assert.equal(rows.length, 28, '84 months -> 28 quarters');
  assert.equal(rows[0].label, 'Q1 24');
});

test('quarterly buckets sum their months', () => {
  const langs = ['en'];
  // Jan/Feb/Mar 2024 carry views 100, 101, 102.
  const { rows } = buildDataRows(analysisFor(langs), fixture(langs, 84));
  assert.equal(rows[0].values.en, 100 + 101 + 102);
});

test('incomplete months are excluded from the table', () => {
  const langs = ['en'];
  const data = fixture(langs, 24);
  data.en[23].complete = false;
  const { rows } = buildDataRows(analysisFor(langs), data);
  assert.equal(rows.length, 23, 'the partial month must not appear');
});

test('a language missing a month leaves a gap rather than a zero', () => {
  const langs = ['en', 'uk'];
  const data = fixture(langs, 24);
  data.uk = data.uk.filter((m) => m.month !== '202403');
  const { rows } = buildDataRows(analysisFor(langs), data);
  const march = rows.find((r) => r.label === '03.24');
  assert.equal(march.values.en, 102);
  assert.equal(march.values.uk, undefined, 'absent, so abbrev renders an en dash');
  assert.equal(abbrev(march.values.uk), '–');
});
