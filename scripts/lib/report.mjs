// Task 5 — the one-page PDF.
//
// Hard rule: every number and every bullet on this page is filled from
// analysis.json. The agent cannot inject figures, only prose, and that prose is
// confined to a clearly labelled "Analyst notes" box. A shareable artifact is
// exactly where a hallucinated number does the most damage, so the artifact is
// built from data rather than from narration.
//
// The page is assembled from a previous run's files, so producing it costs zero
// API calls.

import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { buildLineChart, buildBarChart, drawOn, colorFor, toSvg } from './chart.mjs';

const A4 = { w: 595.28, h: 841.89 };
const M = 40; // page margin
const HERE = path.dirname(new URL(import.meta.url).pathname);
const FONT_DIR = path.join(HERE, '..', '..', 'assets', 'fonts');

const langName = (code) => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
};

/** Read back everything a run wrote. No network. */
export async function loadRun(dir) {
  const analysis = JSON.parse(await readFile(path.join(dir, 'analysis.json'), 'utf8'));
  const monthly = {};
  for (const r of analysis.results) {
    try {
      const raw = await readFile(path.join(dir, 'series', `${r.lang}.monthly.ndjson`), 'utf8');
      monthly[r.lang] = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      monthly[r.lang] = [];
    }
  }
  return { analysis, monthly };
}

/**
 * Index each language's normalized series to 100 at its first usable month, so
 * editions three orders of magnitude apart share one axis.
 */
function indexedLines(analysis, monthly) {
  return analysis.results.map((r, i) => {
    const rows = (monthly[r.lang] ?? []).filter((m) => m.complete);
    const base = rows.find((m) => m.per_million > 0)?.per_million;
    return {
      label: `${r.lang} · ${langName(r.lang)}`,
      color: colorFor(i),
      points: rows.map((m) => ({
        month: m.month,
        value: base && m.per_million != null ? (m.per_million / base) * 100 : null,
      })),
    };
  });
}

/** Limitations are derived from the data, not written by hand. */
export function limitationsFor(analysis) {
  const out = [
    'Wikipedia pageviews measure curiosity, not willingness to pay. Treat any finding here as a direction to validate, not as demand.',
    'Figures are per LANGUAGE EDITION, not per country. There is no per-article country breakdown in this API, and one edition serves many countries (en covers the US, Australia, Canada, South Africa and Ghana alike).',
    'Normalized figures divide by each project’s total traffic. This is what makes editions comparable: every edition is losing human readers, at rates from about -7% (en) to -25% (uk) per year, so raw counts understate a topic that is merely holding its share.',
    'Bot traffic is excluded (agent=user). Raw all-agent traffic runs roughly a third higher.',
  ];
  if (analysis.results.some((r) => r.days_missing > 0)) {
    const worst = Math.max(...analysis.results.map((r) => r.days_missing));
    out.push(
      `Some days have no data upstream (up to ${worst} in this window). They are counted as zero views, which nudges quiet articles downward.`,
    );
  }
  if (analysis.results.some((r) => r.warning === 'measures_broader_topic')) {
    out.push(
      'At least one language measures a broader article that the topic is folded into, so its level is inflated relative to the others.',
    );
  }
  if (analysis.unresolved?.length) {
    out.push(
      `${analysis.unresolved.length} requested language(s) could not be measured; see the gaps section. An absent article is a content gap, not zero interest.`,
    );
  }
  out.push(
    'No quality gating is applied in this version. A cliff in the monthly shape usually means an article was renamed or merged rather than that interest collapsed.',
  );
  return out;
}

/** Draw a sparkline as vector bars. Noto Sans has no block-element glyphs. */
function sparkBars(doc, x, y, w, h, values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (!nums.length) return;
  const max = Math.max(...nums, 1);
  const bw = w / values.length;
  values.forEach((v, i) => {
    if (!Number.isFinite(v)) return;
    const bh = Math.max(0.5, (v / max) * h);
    doc.rect(x + i * bw, y + h - bh, Math.max(0.6, bw * 0.8), bh).fillColor('#5a7d9a').fill();
  });
}

export async function writePdf(runDirPath, outPath, { notes = '' } = {}) {
  const { default: PDFDocument } = await import('pdfkit');
  const { analysis, monthly } = await loadRun(runDirPath);

  const [regular, bold] = await Promise.all([
    readFile(path.join(FONT_DIR, 'NotoSans-Regular.ttf')),
    readFile(path.join(FONT_DIR, 'NotoSans-Bold.ttf')),
  ]);

  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true });
  doc.registerFont('body', regular);
  doc.registerFont('bold', bold);

  // Which strings can the embedded font actually draw? CJK, Arabic, Hebrew,
  // Devanagari and Thai titles are not covered, so they are replaced rather than
  // rendered as empty boxes.
  const fk = await import('fontkit');
  const face = fk.create(regular);
  const canRender = (s) =>
    [...String(s)].every((ch) => ch === ' ' || ch === '·' || face.hasGlyphForCodePoint(ch.codePointAt(0)));

  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((res) => doc.on('end', res));

  let y = M;
  const W = A4.w - 2 * M;

  // ---- header
  doc.font('bold').fontSize(16).fillColor('#111').text(analysis.topic, M, y, { width: W });
  y = doc.y + 2;
  const e = analysis.entity ?? {};
  doc.font('body').fontSize(8.5).fillColor('#555').text(
    `${e.label ? e.label + ' · ' : ''}${e.qid ?? ''}${e.description ? ' — ' + e.description : ''}`,
    M, y, { width: W },
  );
  y = doc.y + 1;
  doc.fontSize(8.5).fillColor('#555').text(
    `Wikipedia pageviews, ${analysis.window.from} to ${analysis.window.to} (${analysis.window.complete_months} complete months) · human traffic only · generated ${new Date().toISOString().slice(0, 10)}`,
    M, y, { width: W },
  );
  y = doc.y + 8;

  // ---- raw-measurement banner
  doc.rect(M, y, W, 15).fillColor('#fff4e5').fill();
  doc.font('bold').fontSize(7.5).fillColor('#8a5a00').text(
    'RAW MEASUREMENTS — no quality gating applied. Read the monthly shape and the limitations before acting.',
    M + 5, y + 4.5, { width: W - 10 },
  );
  y += 24;

  // ---- table
  const cols = [
    { k: 'lang', label: 'Language', w: 116 },
    { k: 'article', label: 'Article measured', w: 150 },
    { k: 'level', label: 'per 1M', w: 46 },
    { k: 'raw', label: 'YoY raw', w: 50 },
    { k: 'norm', label: 'YoY norm', w: 54 },
    { k: 'shape', label: 'Monthly shape', w: 0 },
  ];
  cols.at(-1).w = W - cols.slice(0, -1).reduce((a, c) => a + c.w, 0);

  doc.font('bold').fontSize(7.5).fillColor('#111');
  let cx = M;
  for (const c of cols) {
    doc.text(c.label, cx, y, { width: c.w - 4, lineBreak: false });
    cx += c.w;
  }
  y += 11;
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.6).strokeColor('#bbb').stroke();
  y += 4;

  for (const r of analysis.results) {
    const rows = (monthly[r.lang] ?? []).filter((m) => m.complete);
    const norm = r.normalized && !r.normalized.unavailable ? r.normalized : null;
    const cells = {
      lang: `${langName(r.lang)} (${r.lang})`,
      article: canRender(r.title) ? r.title : `— ${r.lang} script not in PDF font`,
      level: norm ? norm.recent.toFixed(2) : '–',
      raw: r.raw ? `${r.raw.yoy_pct > 0 ? '+' : ''}${r.raw.yoy_pct}%` : 'n/a',
      norm: norm ? `${norm.yoy_pct > 0 ? '+' : ''}${norm.yoy_pct}%` : 'n/a',
    };
    cx = M;
    doc.font('body').fontSize(8).fillColor('#111');
    for (const c of cols) {
      if (c.k === 'shape') {
        sparkBars(doc, cx, y - 1, Math.min(c.w - 6, 120), 9, rows.map((m) => m.views));
      } else {
        doc.fillColor(c.k === 'norm' && norm ? (norm.yoy_pct >= 0 ? '#1a7f37' : '#b3261e') : '#111');
        doc.text(cells[c.k], cx, y, { width: c.w - 4, lineBreak: false, ellipsis: true });
      }
      cx += c.w;
    }
    y += 13;
  }
  y += 6;

  // ---- charts
  const lines = indexedLines(analysis, monthly);
  if (lines.some((l) => l.points.some((p) => p.value != null))) {
    const lc = buildLineChart({
      lines,
      width: W,
      height: 260,
      title: 'Share of each edition’s traffic, indexed to 100 at the window start',
    });
    drawOn(doc, lc, M, y, { canRender });
    y += lc.height + 2;

    // legend
    cx = M;
    doc.fontSize(7.5);
    for (const l of lines) {
      doc.rect(cx, y + 1.5, 7, 3).fillColor(l.color).fill();
      const label = canRender(l.label) ? l.label : l.label.split(' ')[0];
      doc.fillColor('#333').text(label, cx + 10, y, { lineBreak: false });
      cx += 12 + doc.widthOfString(label) + 12;
    }
    y += 14;
  }

  const bars = analysis.results.map((r, i) => ({
    label: `${r.lang} · ${langName(r.lang)}`.slice(0, 22),
    value: r.normalized && !r.normalized.unavailable ? r.normalized.yoy_pct : NaN,
    color: r.normalized && !r.normalized.unavailable && r.normalized.yoy_pct >= 0 ? '#1a7f37' : '#b3261e',
  }));
  const bc = buildBarChart({
    bars,
    width: W,
    height: 26 + bars.length * 22,
    title: 'Year-over-year change in share of edition traffic',
  });
  drawOn(doc, bc, M, y, { canRender });
  y += bc.height + 8;

  // ---- gaps
  if (analysis.unresolved?.length) {
    doc.font('bold').fontSize(8.5).fillColor('#111').text('Languages that could not be measured', M, y);
    y = doc.y + 2;
    doc.font('body').fontSize(7.5).fillColor('#444');
    for (const u of analysis.unresolved) {
      doc.text(`${langName(u.lang)} (${u.lang}) — ${u.reason.replace(/_/g, ' ')}: ${u.detail}`, M + 6, y, {
        width: W - 12,
      });
      y = doc.y + 1;
    }
    y += 5;
  }

  // ---- analyst notes (the only agent-authored region)
  if (notes.trim()) {
    const h = Math.min(60, 16 + Math.ceil(notes.length / 110) * 10);
    doc.rect(M, y, W, h).fillColor('#f2f6fa').fill();
    doc.font('bold').fontSize(7.5).fillColor('#33506b').text('ANALYST NOTES', M + 6, y + 4);
    doc.font('body').fontSize(7.5).fillColor('#22384d').text(notes.trim(), M + 6, y + 14, { width: W - 12, height: h - 18 });
    y += h + 8;
  }

  // ---- limitations
  doc.font('bold').fontSize(8.5).fillColor('#111').text('Assumptions and limitations', M, y);
  y = doc.y + 2;
  doc.font('body').fontSize(7).fillColor('#444');
  for (const l of limitationsFor(analysis)) {
    doc.text(`• ${l}`, M + 4, y, { width: W - 8 });
    y = doc.y + 1.5;
  }

  // ---- footer
  doc.font('body').fontSize(6.5).fillColor('#888').text(
    `Source: Wikimedia Analytics pageviews API (per-article and project aggregate, agent=user), CC0. Run ${analysis.run_id}. Generated by wiki-interest-trends.`,
    M, A4.h - 26, { width: W },
  );

  doc.end();
  await done;
  await mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  const { writeFile } = await import('node:fs/promises');
  const buf = Buffer.concat(chunks);
  await writeFile(outPath, buf);
  return { path: outPath, bytes: buf.length, pages: 1 };
}

/** Standalone SVG of the indexed chart, for viewing without a PDF reader. */
export async function writeSvg(runDirPath, outPath) {
  const { analysis, monthly } = await loadRun(runDirPath);
  const chart = buildLineChart({
    lines: indexedLines(analysis, monthly),
    width: 720,
    height: 300,
    title: `${analysis.topic} — share of edition traffic, indexed to 100`,
  });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(outPath, toSvg(chart), 'utf8');
  return { path: outPath };
}
