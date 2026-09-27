// Task 1 — Resolver: a topic phrase -> one article title per language edition.
//
// The pageviews API measures exact article titles, not topics, so this step is
// where most of the accuracy of the whole skill is won or lost.
//
// Design notes, each earned from observed behaviour:
//   * Wikidata SITELINKS are the source of truth, not the langlinks of some
//     article. For Q1071389 ("gold mining") sitelinks cover 26 language editions
//     including a real German article (Goldbergbau), while English langlinks give
//     25 and point German at "Gold#Gewinnung" — a section, which cannot be
//     measured. Same concept, worse data.
//   * When a language has no sitelink we look at langlinks anyway, purely to
//     explain why (often "it is a section of a broader article").
//   * A sitelink can be a REDIRECT into a broader article. German's sitelink for
//     Q1071389 is "Goldbergbau", which redirects to "Gold" (Q897, the chemical
//     element). Measuring that would count all interest in gold as interest in
//     gold mining. The test that separates a harmless rename from a concept
//     fold: follow the redirect, then compare the target's Wikidata id to the
//     topic's. Same id means a rename; a different id means the concept has been
//     folded into something broader and must not be measured silently.
//   * Nothing is silently dropped or zeroed. A language we cannot measure comes
//     back in `unresolved` with a reason.

import { getJson, NO_DATA, mapLimit, WtError } from './http.mjs';

const WIKIDATA = 'https://www.wikidata.org/w/api.php';

export const projectFor = (lang) => `${lang}.wikipedia`;
/** Wikidata site codes use underscores: be-tarask -> be_taraskwiki */
export const siteFor = (lang) => `${lang.replace(/-/g, '_')}wiki`;
const apiFor = (lang) => `https://${lang}.wikipedia.org/w/api.php`;
const q = (o) => new URLSearchParams({ format: 'json', formatversion: '2', ...o }).toString();

const STOPWORDS = new Set([
  'the','a','an','of','for','to','in','on','and','or','is','are','was','were','be','how','what','why',
  'we','i','our','my','you','your','want','wants','need','build','building','make','making','add','adding',
  'about','with','into','does','do','it','its','that','this','app','apps','course','courses','kids','people',
  'popular','popularity','interest','trend','trends','growing','growth','much','many','best','new',
]);

const tokens = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));

/**
 * How much to trust that this entity is what the user meant.
 *
 * Wikipedia's full-text search ranks articles CONTAINING the words, so a
 * sentence reliably lands on a proper noun: "learning to play guitar" matches
 * the musician Tyler Rich, "astronomy course for kids" matches Crash Course.
 * Those came back silently before. A wrong match is far more expensive than a
 * needless warning, so this errs toward flagging.
 */
/**
 * Does this look like a user's question rather than a topic?
 *
 * Counts RAW words, deliberately not the stopword-filtered tokens used for
 * overlap scoring: "is interest in astronomy growing in Ukrainian Wikipedia"
 * reduces to three content words and would pass as a topic, even though it is
 * plainly a sentence. Length is the signal here, not vocabulary.
 */
export function looksLikeSentence(query) {
  const words = String(query).trim().split(/\s+/).filter(Boolean);
  return words.length >= 5 || /\?$/.test(String(query).trim());
}

// Suffixes Wikipedia uses to separate senses of one name. A parenthetical
// qualifier is the usual form ("Mercury (element)"); companies more often carry a
// legal suffix ("Apple Inc.").
const SENSE_SUFFIX = /\s*\((?:[^()]*)\)\s*$|\s*,?\s*(?:inc|inc\.|ltd|ltd\.|llc|plc|corp|corp\.|corporation|company|gmbh|s\.a\.)\s*$/i;

/** A title with its disambiguating qualifier removed: "Java (island)" -> "Java". */
export const stripQualifier = (title) => String(title).replace(SENSE_SUFFIX, '').trim();

/**
 * Other articles that claim the SAME name as the topic, i.e. competing senses.
 *
 * The rule is deliberately narrow, because the cost of being loose is warning on
 * every topic. A candidate counts only when stripping its qualifier leaves the
 * query itself: "Java (programming language)" and "Apple Inc." do, while
 * "Buddhist meditation" and "Gold mining in Peru" do not -- those are narrower
 * articles about the topic, not rival readings of the name.
 *
 * Why it matters at all: the exact-title route reports `high` confidence and
 * never sees the alternatives, so "Java" resolves to the Indonesian island
 * (Q3757) and "apple" to the fruit (Q89) with nothing to suggest another reading
 * exists. That is the one failure mode in this skill that produces a clean,
 * plausible, wholly wrong answer.
 */
export function competingSenses(query, titles, winnerTitle) {
  const key = (t) => stripQualifier(t).toLowerCase();
  const q = String(query).trim().toLowerCase();
  const target = key(winnerTitle ?? query);
  const seen = new Set([String(winnerTitle ?? '').toLowerCase()]);
  const out = [];
  for (const t of titles ?? []) {
    const title = String(t);
    if (seen.has(title.toLowerCase())) continue;
    if (/\(disambiguation\)\s*$/i.test(title)) continue; // the dab page is not a sense
    const k = key(title);
    if (k !== q && k !== target) continue;
    if (k === title.toLowerCase()) continue; // no qualifier stripped: same name, not a rival sense
    seen.add(title.toLowerCase());
    out.push(title);
  }
  return out;
}

/**
 * Which candidate to measure, decided reproducibly.
 *
 * Search rank cannot be trusted to do it: two identical "Mercury" queries minutes
 * apart returned Q308 (the planet) and Q15869 (Freddie Mercury) as the top usable
 * hit, so the skill would have measured different concepts on identical input and
 * a user comparing two runs would see the change as a change in interest.
 *
 * So: prefer candidates whose title IS the queried name once a qualifier is
 * stripped -- the rival readings of the term, not a person or label that merely
 * contains it. Among those, take the longest article, which `verifyTitles`
 * already treats as a depth signal and which tracks prominence closely enough:
 * "Python (programming language)" runs to tens of thousands of bytes against a
 * few thousand for "Python (missile)". Wikidata id ascending breaks an exact tie,
 * for reproducibility only. Where no candidate matches the name, search rank is
 * genuine relevance information and is kept.
 *
 * Ordering by id alone was tried first and is wrong: Q15728 (a 1978 air-to-air
 * missile) precedes Q28865 (the programming language), so "Python" resolved to
 * the missile.
 */
export function pickWinner(topic, candidates) {
  const withQid = (candidates ?? []).filter((c) => c.qid);
  if (withQid.length < 2) return withQid[0] ?? null;
  const q = String(topic).trim().toLowerCase();
  const base = withQid.filter((c) => stripQualifier(c.title).toLowerCase() === q);
  if (base.length === 1) return base[0];
  if (base.length > 1) {
    const num = (qid) => Number(String(qid).replace(/^Q/i, '')) || Number.MAX_SAFE_INTEGER;
    return [...base].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0) || num(a.qid) - num(b.qid))[0];
  }
  return withQid[0];
}

export function matchConfidence(query, { via, title, label, senses = [] }) {
  // A rival sense caps confidence wherever the match came from. An exact title is
  // strong evidence that the STRING is right and says nothing about which of two
  // meanings the user had in mind.
  const ambiguity = senses.length
    ? {
        confidence: 'medium',
        why:
          `"${title}" is not the only article under this name — Wikipedia also has ` +
          `${senses.map((x) => `"${x.title}"`).join(', ')}. Measured "${title}". ` +
          `If the user meant another sense, re-run with that exact title.`,
      }
    : null;

  if (via === 'exact-title') return ambiguity ?? { confidence: 'high' };

  const q = tokens(query);
  const t = new Set([...tokens(title), ...tokens(label ?? '')]);
  const hits = q.filter((w) => t.has(w));
  const coverage = q.length ? hits.length / q.length : 0;

  // No article title is a sentence. A long query means the caller passed the
  // user's question through instead of extracting a topic, and Wikipedia's
  // full-text search will happily return whichever article contains the most
  // words: "how has gold mining interest changed for the last 6 months?" lands
  // on "Mining industry of the Democratic Republic of the Congo".
  if (looksLikeSentence(query)) {
    return {
      confidence: 'low',
      why: `"${query}" looks like a sentence, not a topic. Wikipedia matched "${title}". Re-run with a short noun phrase (e.g. "gold mining") and put the time range in --since.`,
    };
  }
  if (hits.length === 0) {
    return {
      confidence: 'low',
      why: `"${title}" shares no significant word with "${query}" — this is probably the wrong article`,
    };
  }
  if (coverage < 0.5) {
    return {
      confidence: 'low',
      why: `"${title}" matches only ${hits.map((h) => `"${h}"`).join(', ')} of "${query}" — probably the wrong article`,
    };
  }
  if (coverage < 1) {
    return {
      confidence: 'medium',
      why:
        `matched on ${hits.map((h) => `"${h}"`).join(', ')}; confirm "${title}" is the intended article` +
        (ambiguity ? `. ${ambiguity.why}` : ''),
    };
  }
  return ambiguity ?? { confidence: 'medium' };
}

/**
 * Find the Wikidata entity for a free-text topic.
 * Tries the cheapest, most precise route first and records which route won so
 * the caller can show it.
 */
// A rival sense is worth mentioning only if it is a developed article. Observed
// sizes on en, for the senses a disambiguation page lists:
//   Turkey     -> bird 41,214 | nickname 710 | bowling 118
//   Java       -> software platform 79,155 | programming language 75,161 | ship 9,745
//   apple      -> Apple Inc. 272,516 | artwork 4,239 | 1910s automobile 3,265
//   meditation -> a painting 14,610 | a Jobim song 9,198 | a writing form 3,435
// The floor has to sit above meditation's trivia and below Turkey's bird, which
// is what separates "the user may well have meant this" from an index entry. A
// share of the measured article is kept as an alternative test, because 20 kB
// means something different in a small edition than it does on en.
const SENSE_MIN_BYTES = 20_000;
const SENSE_MIN_SHARE = 0.5;
const SENSE_MAX = 3; // a report bullet naming six senses is not read

/**
 * Rival senses, taken from the disambiguation page rather than from search.
 *
 * Search rank was tried first and is too unstable at the tail: "Turkey (bird)"
 * came ninth of ten one day and outside the top ten the next, so the same query
 * reported the ambiguity or missed it depending on the hour. A disambiguation
 * page is Wikipedia's own enumeration of the senses and changes rarely.
 *
 * One request: `generator=links` over the dab page with `prop=info|pageprops`
 * returns each linked article with its size and Wikidata id together.
 */
async function sensesFromDab(lang, dabTitle, topic, winnerBytes) {
  const d = await getJson(
    `${apiFor(lang)}?${q({
      action: 'query',
      titles: dabTitle,
      generator: 'links',
      gplnamespace: '0',
      gpllimit: '500',
      prop: 'info|pageprops',
    })}`,
  );
  if (d === NO_DATA) return [];
  const pages = (d?.query?.pages ?? []).filter(
    (p) => !p.missing && p.pageprops?.disambiguation === undefined && p.pageprops?.wikibase_item,
  );
  const keep = new Set(competingSenses(topic, pages.map((p) => p.title), dabTitle));
  const floor = Math.min(SENSE_MIN_BYTES, Math.max(1, (winnerBytes ?? 0) * SENSE_MIN_SHARE));
  return pages
    .filter((p) => keep.has(p.title) && (p.length ?? 0) >= floor)
    .sort((a, b) => (b.length ?? 0) - (a.length ?? 0))
    .slice(0, SENSE_MAX)
    .map((p) => ({ title: p.title, qid: p.pageprops.wikibase_item }));
}

/** The page that enumerates this name's senses, if Wikipedia has one. */
function dabTitleFor(pages, topic) {
  const dab = (pages ?? []).find((p) => !p.missing && p.pageprops?.disambiguation !== undefined);
  return dab?.title ?? null;
}

export async function findEntity(topic, { fromLang = 'en' } = {}) {
  const candidates = [];

  // 1. Exact title match on the source wiki (follows redirects), and the
  //    full-text search in the SAME request: MediaWiki allows a `list=` beside
  //    `titles=`, so rival senses cost no extra round trip on the exact-title
  //    route, and the search route makes one request fewer than it used to.
  // Three jobs in one request: the exact-title lookup, the full-text search, and
  // "does a disambiguation page exist for this name". MediaWiki allows several
  // titles and a `list=` in the same query, so none of that costs a round trip.
  const byTitle = await getJson(
    `${apiFor(fromLang)}?${q({
      action: 'query',
      titles: [topic, `${topic} (disambiguation)`].join('|'),
      prop: 'pageprops|info',
      redirects: '1',
      list: 'search',
      srsearch: topic,
      srlimit: '10',
    })}`,
  );
  const pages = byTitle !== NO_DATA ? (byTitle?.query?.pages ?? []) : [];
  const wanted = String(topic).trim().toLowerCase();
  const page =
    pages.find((p) => !p.missing && p.title.toLowerCase() === wanted) ??
    pages.find((p) => !p.missing && !/\(disambiguation\)$/i.test(p.title)) ??
    null;
  const dabTitle = dabTitleFor(pages, topic);
  const hits = byTitle !== NO_DATA ? (byTitle?.query?.search ?? []) : [];

  if (page && !page.missing) {
    const qid = page.pageprops?.wikibase_item;
    const isDab = page.pageprops?.disambiguation !== undefined;
    if (qid && !isDab) {
      // One extra request, and only for a name Wikipedia itself disambiguates.
      const senses = dabTitle ? await sensesFromDab(fromLang, dabTitle, topic, page.length) : [];
      return { qid, via: 'exact-title', sourceTitle: page.title, sourceLang: fromLang, candidates, senses };
    }
    if (isDab) candidates.push({ title: page.title, note: 'disambiguation page, skipped' });
  }

  // 2. Full-text search results, from the request above.
  if (hits.length) {
    const titles = hits.map((h) => h.title).join('|');
    const info = await getJson(
      `${apiFor(fromLang)}?${q({ action: 'query', titles, prop: 'pageprops|info', redirects: '1' })}`,
    );
    const pages = info !== NO_DATA ? (info?.query?.pages ?? []) : [];
    const byTitleMap = new Map(pages.map((p) => [p.title, p]));
    for (const h of hits) {
      const p = byTitleMap.get(h.title);
      const qid = p?.pageprops?.wikibase_item;
      const isDab = p?.pageprops?.disambiguation !== undefined;
      if (!qid || isDab) continue;
      candidates.push({ title: h.title, qid, ...(p.length != null && { bytes: p.length }) });
    }
    const winner = pickWinner(topic, candidates);
    if (winner) {
      const senses = dabTitle
        ? (await sensesFromDab(fromLang, dabTitle, topic, winner.bytes)).filter((x) => x.qid !== winner.qid)
        : [];
      return {
        qid: winner.qid,
        via: 'wiki-search',
        sourceTitle: winner.title,
        sourceLang: fromLang,
        candidates: candidates.filter((c) => c !== winner).slice(0, 3),
        senses,
      };
    }
  }

  // 3. Wikidata entity search, as a last resort.
  const wd = await getJson(
    `${WIKIDATA}?${q({ action: 'wbsearchentities', search: topic, language: 'en', uselang: 'en', limit: '5' })}`,
  );
  const first = wd !== NO_DATA ? wd?.search?.[0] : null;
  if (first) {
    return {
      qid: first.id,
      via: 'wikidata-search',
      sourceTitle: first.label,
      sourceLang: fromLang,
      label: first.label,
      description: first.description,
      candidates: (wd.search ?? []).slice(1, 4).map((s) => ({ qid: s.id, title: s.label, note: s.description })),
    };
  }

  throw new WtError('topic_not_found', `Could not match "${topic}" to any Wikipedia article or Wikidata item.`, {
    fix: 'Try a more specific phrase, or pass --article to name an exact title.',
  });
}

/** Wikidata label + description, for showing what we actually locked onto. */
export async function entityLabel(qid) {
  const d = await getJson(
    `${WIKIDATA}?${q({ action: 'wbgetentities', ids: qid, props: 'labels|descriptions', languages: 'en' })}`,
  );
  if (d === NO_DATA) return {};
  const e = d?.entities?.[qid] ?? {};
  return { label: e.labels?.en?.value, description: e.descriptions?.en?.value };
}

/** Sitelinks for the requested languages only. One request. */
export async function sitelinksFor(qid, langs) {
  const d = await getJson(
    `${WIKIDATA}?${q({
      action: 'wbgetentities',
      ids: qid,
      props: 'sitelinks',
      sitefilter: langs.map(siteFor).join('|'),
    })}`,
  );
  if (d === NO_DATA) return {};
  const links = d?.entities?.[qid]?.sitelinks ?? {};
  const out = {};
  for (const lang of langs) {
    const hit = links[siteFor(lang)];
    if (hit?.title) out[lang] = hit.title;
  }
  return out;
}

/**
 * Why does this language have no article? Usually the concept is folded into a
 * broader page. Langlinks reveal that; sitelinks cannot.
 */
async function explainMissing(sourceLang, sourceTitle, missingLangs) {
  if (!missingLangs.length || !sourceTitle) return {};
  const d = await getJson(
    `${apiFor(sourceLang)}?${q({
      action: 'query',
      titles: sourceTitle,
      prop: 'langlinks',
      lllimit: '500',
      redirects: '1',
    })}`,
  );
  if (d === NO_DATA) return {};
  const ll = new Map((d?.query?.pages?.[0]?.langlinks ?? []).map((l) => [l.lang, l.title]));
  const out = {};
  for (const lang of missingLangs) {
    const t = ll.get(lang);
    if (!t) continue;
    out[lang] = t.includes('#')
      ? { reason: 'section_only', detail: `covered as a section: ${t}`, target: t }
      : { reason: 'not_linked_in_wikidata', detail: `langlink exists (${t}) but no Wikidata sitelink`, target: t };
  }
  return out;
}

/**
 * Confirm each title still exists, get its canonical form, and flag
 * disambiguation pages. Also returns byte size, a rough article-depth signal.
 */
export async function verifyTitles(lang, titles) {
  if (!titles.length) return {};
  const d = await getJson(
    `${apiFor(lang)}?${q({
      action: 'query',
      titles: titles.join('|'),
      prop: 'info|pageprops',
      redirects: '1',
    })}`,
  );
  if (d === NO_DATA) return {};
  const out = {};
  // Redirect hops must be followed to attribute each result to its input title.
  const redirectOf = new Map((d?.query?.redirects ?? []).map((r) => [r.from, r.to]));
  const normalizedOf = new Map((d?.query?.normalized ?? []).map((n) => [n.from, n.to]));
  const pages = new Map((d?.query?.pages ?? []).map((p) => [p.title, p]));
  for (const requested of titles) {
    let t = normalizedOf.get(requested) ?? requested;
    t = redirectOf.get(t) ?? t;
    const p = pages.get(t);
    out[requested] = p
      ? {
          missing: Boolean(p.missing),
          canonical: p.title,
          bytes: p.length ?? null,
          qid: p.pageprops?.wikibase_item ?? null,
          disambiguation: p.pageprops?.disambiguation !== undefined,
          redirectedFrom: t === requested ? null : requested,
        }
      : { missing: true, canonical: requested };
  }
  return out;
}

/**
 * Full resolve step. Returns what is measurable and, for everything else, why not.
 */
export async function resolveTopic(topic, langs, { fromLang = 'en', verify = true, allowFold = false } = {}) {
  const entity = await findEntity(topic, { fromLang });
  const [meta, links] = await Promise.all([
    entity.label ? Promise.resolve({ label: entity.label, description: entity.description }) : entityLabel(entity.qid),
    sitelinksFor(entity.qid, langs),
  ]);

  const missing = langs.filter((l) => !links[l]);
  const reasons = await explainMissing(entity.sourceLang, entity.sourceTitle, missing);

  const verified = verify
    ? Object.fromEntries(
        await mapLimit(Object.entries(links), 4, async ([lang, title]) => [lang, await verifyTitles(lang, [title])]),
      )
    : {};

  const resolved = [];
  const unresolved = [];

  for (const lang of langs) {
    const title = links[lang];
    if (!title) {
      const r = reasons[lang];
      unresolved.push({
        lang,
        reason: r?.reason ?? 'no_article',
        detail: r?.detail ?? `${entity.qid} has no ${siteFor(lang)} sitelink`,
        ...(r?.target && { target: r.target }),
      });
      continue;
    }
    const v = verified[lang]?.[title];
    if (v?.missing) {
      unresolved.push({
        lang,
        reason: 'title_gone',
        detail: `Wikidata points at "${title}" but that page no longer exists`,
      });
      continue;
    }
    // A redirect landing on a DIFFERENT Wikidata item means this language folds
    // the concept into a broader article. Measuring it would answer a different
    // question, so by default we report the gap instead.
    const folded = v?.redirectedFrom && v.qid && v.qid !== entity.qid;
    if (folded && !allowFold) {
      unresolved.push({
        lang,
        reason: 'folded_into_broader_article',
        detail: `"${title}" redirects to "${v.canonical}" (${v.qid}), a different concept — no dedicated article exists`,
        target: v.canonical,
        target_qid: v.qid,
      });
      continue;
    }
    resolved.push({
      lang,
      project: projectFor(lang),
      title: v?.canonical ?? title,
      ...(v?.bytes != null && { bytes: v.bytes }),
      ...(v?.disambiguation && { warning: 'disambiguation_page' }),
      ...(folded && { warning: 'measures_broader_topic' }),
      ...(v?.redirectedFrom && { redirected_from: v.redirectedFrom }),
    });
  }

  const match = matchConfidence(topic, {
    via: entity.via,
    title: entity.sourceTitle,
    label: meta.label,
    senses: entity.senses ?? [],
  });

  return {
    topic,
    entity: {
      qid: entity.qid,
      label: meta.label,
      description: meta.description,
      via: entity.via,
      source_title: entity.sourceTitle,
      ...match,
      ...(entity.senses?.length && { other_senses: entity.senses }),
    },
    ...(entity.candidates?.length && { other_candidates: entity.candidates }),
    resolved,
    unresolved,
  };
}
