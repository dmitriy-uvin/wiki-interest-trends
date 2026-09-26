// Task 1 tests. Every case here is a failure mode observed against the live API,
// recorded as a fixture so the suite runs offline and deterministically.

process.env.WT_FIXTURES = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTopic, siteFor, projectFor, findEntity } from '../scripts/lib/resolve.mjs';

const LANGS = ['en', 'de', 'fr', 'es', 'pl'];
const byLang = (rows) => Object.fromEntries(rows.map((r) => [r.lang, r]));

test('site codes use underscores, projects use the language code', () => {
  assert.equal(siteFor('en'), 'enwiki');
  assert.equal(siteFor('be-tarask'), 'be_taraskwiki');
  assert.equal(projectFor('uk'), 'uk.wikipedia');
});

test('resolves a topic to its Wikidata entity via an exact title match', async () => {
  const e = await findEntity('gold mining');
  assert.equal(e.qid, 'Q1071389');
  assert.equal(e.via, 'exact-title');
  assert.equal(e.sourceTitle, 'Gold mining');
});

test('a language with no sitelink is reported as a gap, never as zero views', async () => {
  const r = await resolveTopic('gold mining', LANGS);
  const pl = byLang(r.unresolved).pl;
  assert.ok(pl, 'pl must appear in unresolved');
  assert.equal(pl.reason, 'no_article');
  assert.ok(!byLang(r.resolved).pl, 'pl must not appear as measurable');
});

test('a sitelink redirecting to a different Wikidata item is a concept fold, not a rename', async () => {
  // de: Goldbergbau -> Gold (Q897, the chemical element). Measuring it would
  // count interest in gold as interest in gold mining.
  const r = await resolveTopic('gold mining', LANGS);
  const de = byLang(r.unresolved).de;
  assert.ok(de, 'de must be excluded by default');
  assert.equal(de.reason, 'folded_into_broader_article');
  assert.equal(de.target, 'Gold');
  assert.equal(de.target_qid, 'Q897');
});

test('--allow-fold opts in to measuring the broader article, and flags it', async () => {
  const r = await resolveTopic('gold mining', LANGS, { allowFold: true });
  const de = byLang(r.resolved).de;
  assert.ok(de, 'de must be measurable when folds are allowed');
  assert.equal(de.title, 'Gold');
  assert.equal(de.warning, 'measures_broader_topic');
  assert.equal(de.redirected_from, 'Goldbergbau');
});

test('a drifted title is measured but shown, since Wikidata calls it the same concept', async () => {
  // fr: "Histoire des mines d'or" (History of gold mines) shares Q1071389, so no
  // automated check can reject it. The mitigation is that the title is visible.
  const r = await resolveTopic('gold mining', LANGS);
  const fr = byLang(r.resolved).fr;
  assert.equal(fr.title, "Histoire des mines d'or");
});

test("the brief's own example: pl has no intermittent fasting article", async () => {
  const r = await resolveTopic('intermittent fasting', ['pl', 'cs']);
  assert.equal(r.entity.qid, 'Q1666254');
  assert.equal(byLang(r.resolved).cs.title, 'Přerušovaný půst');
  assert.equal(byLang(r.unresolved).pl.reason, 'no_article');
});

test('every requested language appears in exactly one of resolved or unresolved', async () => {
  const r = await resolveTopic('gold mining', LANGS);
  const seen = [...r.resolved, ...r.unresolved].map((x) => x.lang);
  assert.deepEqual(seen.sort(), [...LANGS].sort());
  assert.equal(new Set(seen).size, seen.length, 'no language may appear twice');
});
