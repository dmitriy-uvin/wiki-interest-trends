// Ambiguity: when one name has several articles behind it.
//
// Every case below was observed live. The two that must keep working in the
// negative direction are `meditation` and `gold mining`: a rule that warns about
// those warns about everything, and a confidence label that is never `high`
// carries no information.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { competingSenses, stripQualifier, pickWinner, matchConfidence } from '../scripts/lib/resolve.mjs';

test('a qualifier is stripped, a descriptive title is left alone', () => {
  assert.equal(stripQualifier('Java (programming language)'), 'Java');
  assert.equal(stripQualifier('Apple Inc.'), 'Apple');
  assert.equal(stripQualifier('Mercury (element)'), 'Mercury');
  assert.equal(stripQualifier('Buddhist meditation'), 'Buddhist meditation');
  assert.equal(stripQualifier('Gold mining in Peru'), 'Gold mining in Peru');
});

test('rival readings of a name are found', () => {
  // en "Java" is the Indonesian island, and nothing in the exact-title route used
  // to reveal that a programming language shares the title.
  assert.deepEqual(
    competingSenses('Java', ['Java', 'Java (programming language)', 'Javanese people', 'Java coffee'], 'Java'),
    ['Java (programming language)'],
  );
  assert.deepEqual(competingSenses('apple', ['Apple', 'Apple Inc.', 'Apple pie'], 'Apple'), ['Apple Inc.']);
  assert.deepEqual(
    competingSenses('Mercury', ['Mercury (element)', 'Mercury (planet)', 'Freddie Mercury'], 'Mercury (planet)'),
    ['Mercury (element)'],
  );
});

test('narrower articles about the topic are not rival senses', () => {
  assert.deepEqual(
    competingSenses('meditation', ['Meditation', 'Buddhist meditation', 'Christian meditation', 'Meditation (disambiguation)'], 'Meditation'),
    [],
    'a topic with sub-articles must not start warning',
  );
  assert.deepEqual(
    competingSenses('gold mining', ['Gold mining', 'Gold mining in Peru', 'History of gold mining'], 'Gold mining'),
    [],
  );
});

test('the disambiguation page itself is never offered as a sense', () => {
  assert.deepEqual(competingSenses('Python', ['Python (disambiguation)', 'Monty Python'], 'Python (programming language)'), []);
});

test('the winner is chosen reproducibly, not by search rank', () => {
  // Live, minutes apart, "Mercury" put Q925 then Q15869 at the top of the usable
  // hits. Identical input must not measure a different concept.
  const asRanked = [
    { title: 'Mercury (element)', qid: 'Q925' },
    { title: 'Mercury (planet)', qid: 'Q308' },
    { title: 'Freddie Mercury', qid: 'Q15869' },
  ];
  const reordered = [asRanked[2], asRanked[1], asRanked[0]];
  assert.equal(pickWinner('Mercury', asRanked).qid, 'Q308');
  assert.equal(pickWinner('Mercury', reordered).qid, 'Q308', 'order of the input must not change the answer');
});

test('among rival senses the deeper article wins, not the older item', () => {
  // Ordering by Wikidata id put a 1978 air-to-air missile (Q15728) ahead of the
  // programming language (Q28865), so "Python" resolved to the missile.
  const hits = [
    { title: 'Python (missile)', qid: 'Q15728', bytes: 9_000 },
    { title: 'Python (programming language)', qid: 'Q28865', bytes: 180_000 },
  ];
  assert.equal(pickWinner('Python', hits).qid, 'Q28865');
  assert.equal(pickWinner('Python', [...hits].reverse()).qid, 'Q28865', 'still independent of input order');
});

test('with no size information the pick is still reproducible', () => {
  const hits = [
    { title: 'Mercury (element)', qid: 'Q925' },
    { title: 'Mercury (planet)', qid: 'Q308' },
  ];
  assert.equal(pickWinner('Mercury', hits).qid, 'Q308', 'id ascending is the last resort, not the first');
});

test('a name-bearing candidate beats a merely-related one', () => {
  const hits = [
    { title: 'Monty Python', qid: 'Q16402' },
    { title: 'Python (programming language)', qid: 'Q28865' },
  ];
  assert.equal(pickWinner('Python', hits).qid, 'Q28865');
});

test('where nothing matches the name, search relevance is kept', () => {
  const hits = [
    { title: 'Intermittent fasting', qid: 'Q1666254' },
    { title: 'Fasting', qid: 'Q1058188' },
  ];
  assert.equal(pickWinner('intermittent fasting protocols', hits).qid, 'Q1666254');
});

test('a rival sense caps an exact-title match at medium and says what else it could be', () => {
  const clean = matchConfidence('meditation', { via: 'exact-title', title: 'Meditation' });
  assert.equal(clean.confidence, 'high');
  assert.ok(!clean.why);

  const ambiguous = matchConfidence('Java', {
    via: 'exact-title',
    title: 'Java',
    senses: [{ title: 'Java (programming language)', qid: 'Q251' }],
  });
  assert.equal(ambiguous.confidence, 'medium', 'an exact title proves the string, not the meaning');
  assert.match(ambiguous.why, /Java \(programming language\)/);
  assert.match(ambiguous.why, /re-run with that exact title/i);
});

test('ambiguity never upgrades a bad match', () => {
  const r = matchConfidence('how is interest in Java changing this year', {
    via: 'wiki-search',
    title: 'Java',
    senses: [{ title: 'Java (programming language)', qid: 'Q251' }],
  });
  assert.equal(r.confidence, 'low', 'a sentence query stays low whatever the senses say');
});
