// Task 1 — Resolver: a topic phrase -> one article title per language edition.
//
// The pageviews API measures exact article titles, not topics, so this step is
// where most of the accuracy of the whole skill is won or lost.
//
// Design notes, each earned from observed behaviour:
//   * Wikidata SITELINKS are the source of truth, not the langlinks of some
//     article. For Q1071389 ("gold mining") sitelinks give 28 languages
//     including a real German article (Goldbergbau), while English langlinks
//     give 25 and point German at "Gold#Gewinnung" — a section, which cannot be
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

export function matchConfidence(query, { via, title, label }) {
  if (via === 'exact-title') return { confidence: 'high' };

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
      why: `matched on ${hits.map((h) => `"${h}"`).join(', ')}; confirm "${title}" is the intended article`,
    };
  }
  return { confidence: 'medium' };
}

/**
 * Find the Wikidata entity for a free-text topic.
 * Tries the cheapest, most precise route first and records which route won so
 * the caller can show it.
 */
export async function findEntity(topic, { fromLang = 'en' } = {}) {
  const candidates = [];

  // 1. Exact title match on the source wiki (follows redirects).
  const byTitle = await getJson(
    `${apiFor(fromLang)}?${q({ action: 'query', titles: topic, prop: 'pageprops', redirects: '1' })}`,
  );
  const page = byTitle !== NO_DATA ? byTitle?.query?.pages?.[0] : null;
  if (page && !page.missing) {
    const qid = page.pageprops?.wikibase_item;
    const isDab = page.pageprops?.disambiguation !== undefined;
    if (qid && !isDab) {
      return { qid, via: 'exact-title', sourceTitle: page.title, sourceLang: fromLang, candidates };
    }
    if (isDab) candidates.push({ title: page.title, note: 'disambiguation page, skipped' });
  }

  // 2. Full-text search on the source wiki.
  const search = await getJson(
    `${apiFor(fromLang)}?${q({ action: 'query', list: 'search', srsearch: topic, srlimit: '5' })}`,
  );
  const hits = search !== NO_DATA ? (search?.query?.search ?? []) : [];
  if (hits.length) {
    const titles = hits.map((h) => h.title).join('|');
    const info = await getJson(
      `${apiFor(fromLang)}?${q({ action: 'query', titles, prop: 'pageprops', redirects: '1' })}`,
    );
    const pages = info !== NO_DATA ? (info?.query?.pages ?? []) : [];
    const byTitleMap = new Map(pages.map((p) => [p.title, p]));
    for (const h of hits) {
      const p = byTitleMap.get(h.title);
      const qid = p?.pageprops?.wikibase_item;
      const isDab = p?.pageprops?.disambiguation !== undefined;
      if (!qid || isDab) continue;
      candidates.push({ title: h.title, qid });
    }
    const winner = candidates.find((c) => c.qid);
    if (winner) {
      return {
        qid: winner.qid,
        via: 'wiki-search',
        sourceTitle: winner.title,
        sourceLang: fromLang,
        candidates: candidates.filter((c) => c !== winner).slice(0, 3),
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

  const match = matchConfidence(topic, { via: entity.via, title: entity.sourceTitle, label: meta.label });

  return {
    topic,
    entity: {
      qid: entity.qid,
      label: meta.label,
      description: meta.description,
      via: entity.via,
      source_title: entity.sourceTitle,
      ...match,
    },
    ...(entity.candidates?.length && { other_candidates: entity.candidates }),
    resolved,
    unresolved,
  };
}
