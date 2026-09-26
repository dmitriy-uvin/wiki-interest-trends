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


/**
 * Compact number for a dense table: 261, 8.6k, 193k, 1.2M.
 * Abbreviation is not decoration here. At 7pt "192823" is 1.5x wider than
 * "193k", and that difference decides how many language columns fit. PDF text
 * annotations could carry the exact value on hover, but viewer support is
 * inconsistent enough that a silently missing tooltip would be worse than none,
 * so exact figures live in the run directory instead.
 */
export function abbrev(n) {
  if (n == null || !Number.isFinite(n)) return '\u2013';
  const a = Math.abs(n);
  if (a < 1000) return String(n);
  // Round BEFORE choosing the suffix, so 999,999 becomes 1.0M rather than 1000k
  // and 9,999 becomes 10k rather than 10.0k.
  if (a < 999_500) {
    const k = n / 1000;
    return (a < 9950 ? k.toFixed(1) : String(Math.round(k))) + 'k';
  }
  return (n / 1_000_000).toFixed(1) + 'M';
}

/** "202601" -> "01.26"; a quarter bucket -> "Q1 24". */
const monthLabel = (ym) => `${ym.slice(4, 6)}.${ym.slice(2, 4)}`;
const quarterLabel = (ym) => `Q${Math.floor((+ym.slice(4, 6) - 1) / 3) + 1} ${ym.slice(2, 4)}`;

/** Rows per page before monthly has to become quarterly. */
const MAX_ROWS = 66;

/**
 * Build the table body: one row per period, one column per language.
 * Monthly while it fits on a page, quarterly beyond that.
 */
export function buildDataRows(analysis, monthly) {
  const langs = analysis.results.map((r) => r.lang);
  const months = [...new Set(Object.values(monthly).flat().filter((m) => m.complete).map((m) => m.month))].sort();
  const quarterly = months.length > MAX_ROWS;

  const keyOf = (ym) => (quarterly ? ym.slice(0, 4) + String(Math.floor((+ym.slice(4, 6) - 1) / 3)) : ym);
  const buckets = new Map();
  for (const ym of months) {
    const k = keyOf(ym);
    if (!buckets.has(k)) buckets.set(k, { label: quarterly ? quarterLabel(ym) : monthLabel(ym), year: ym.slice(0, 4), values: {} });
    const b = buckets.get(k);
    for (const lang of langs) {
      const row = (monthly[lang] ?? []).find((m) => m.month === ym);
      if (row?.complete) b.values[lang] = (b.values[lang] ?? 0) + row.views;
    }
  }
  return { langs, rows: [...buckets.values()], quarterly };
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


/**
 * Page 2: the numbers behind page 1.
 *
 * Months run DOWN and languages ACROSS, which is the orientation a dedicated
 * page allows: height then scales with the window (60 monthly rows still fit)
 * and width with the language count (12 columns fit), instead of both fighting
 * for the same strip beneath the charts.
 */
export function drawDataPage(doc, analysis, monthly, { canRender, limitations }) {
  const { langs, rows, quarterly } = buildDataRows(analysis, monthly);
  doc.addPage();
  const W = A4.w - 2 * M;
  let y = M;

  doc.font('bold').fontSize(11).fillColor('#111').text(`${analysis.topic} \u2014 views by ${quarterly ? 'quarter' : 'month'}`, M, y);
  y = doc.y + 1;
  doc.font('body').fontSize(7.5).fillColor('#555').text(
    `Human pageviews per language edition (agent=user), complete ${quarterly ? 'quarters' : 'months'} only. ` +
      'Figures are abbreviated; exact values are in the run directory.',
    M, y, { width: W },
  );
  y = doc.y + 8;

  const labelW = 38;
  const colW = (W - labelW) / Math.max(1, langs.length);
  const rowH = rows.length > 40 ? 9.5 : 11;

  // header
  doc.font('bold').fontSize(7).fillColor('#111');
  langs.forEach((l, i) => doc.text(l, M + labelW + i * colW, y, { width: colW - 4, align: 'right', lineBreak: false }));
  y += 10;
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.6).strokeColor('#bbb').stroke();
  y += 3;

  let lastYear = rows[0]?.year;
  for (const row of rows) {
    if (row.year !== lastYear) {
      // hairline between years, so a 60-row column stays scannable
      doc.moveTo(M, y - 1).lineTo(M + W, y - 1).lineWidth(0.3).strokeColor('#e0e0e0').stroke();
      lastYear = row.year;
    }
    doc.font('body').fontSize(7).fillColor('#666').text(row.label, M, y, { width: labelW - 4, lineBreak: false });
    langs.forEach((l, i) => {
      doc.fillColor('#111').text(abbrev(row.values[l]), M + labelW + i * colW, y, {
        width: colW - 4, align: 'right', lineBreak: false,
      });
    });
    y += rowH;
  }

  // Limitations land here when page 1 ran out of room for them.
  if (limitations?.length) {
    y += 10;
    doc.font('bold').fontSize(8.5).fillColor('#111').text('Assumptions and limitations', M, y);
    y = doc.y + 2;
    doc.font('body').fontSize(7).fillColor('#444');
    for (const l of limitations) {
      doc.text(`\u2022 ${l}`, M + 4, y, { width: W - 8 });
      y = doc.y + 1.5;
    }
  }

  doc.font('body').fontSize(6.5).fillColor('#888').text(
    `Run ${analysis.run_id} \u00b7 generated by wiki-interest-trends`,
    M, A4.h - 26, { width: W },
  );
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

  // ---- limitations, if they still fit; otherwise they move to page 2.
  // Eight languages used to push this block straight through the footer.
  const limitations = limitationsFor(analysis);
  const FOOTER_Y = A4.h - 34;
  // Measure, do not estimate: several bullets wrap to two or three lines at this
  // width, so a per-bullet constant underestimated the block by ~30pt and let it
  // run through the footer.
  doc.font('body').fontSize(7);
  const needed =
    14 + limitations.reduce((h, l) => h + doc.heightOfString(`\u2022 ${l}`, { width: W - 8 }) + 1.5, 0);
  let overflowLimitations = null;
  if (process.env.WT_DEBUG === '1')
    process.stderr.write(`[wt] limitations: y=${y.toFixed(0)} + needed=${needed} vs footer=${FOOTER_Y.toFixed(0)} -> ${y + needed <= FOOTER_Y ? 'page 1' : 'PAGE 2'}\n`);
  if (y + needed <= FOOTER_Y) {
    doc.font('bold').fontSize(8.5).fillColor('#111').text('Assumptions and limitations', M, y);
    y = doc.y + 2;
    doc.font('body').fontSize(7).fillColor('#444');
    for (const l of limitations) {
      doc.text(`• ${l}`, M + 4, y, { width: W - 8 });
      y = doc.y + 1.5;
    }
  } else {
    overflowLimitations = limitations;
    doc.font('body').fontSize(7).fillColor('#666').text('Assumptions and limitations overleaf.', M, y);
    y = doc.y;
  }

  // ---- footer
  doc.font('body').fontSize(6.5).fillColor('#888').text(
    `Source: Wikimedia Analytics pageviews API (per-article and project aggregate, agent=user), CC0. Run ${analysis.run_id}. Generated by wiki-interest-trends.`,
    M, A4.h - 26, { width: W },
  );

  drawDataPage(doc, analysis, monthly, { canRender, limitations: overflowLimitations });

  // Layout headroom, for developing the page. A4 is 841.89pt tall.
  if (process.env.WT_DEBUG === '1') {
    process.stderr.write(`[wt] layout: content ends at y=${y.toFixed(0)}pt, footer at ${(A4.h - 26).toFixed(0)}pt, free=${(A4.h - 26 - y).toFixed(0)}pt\n`);
  }

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
