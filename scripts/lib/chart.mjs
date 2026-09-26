// Charts, built once and rendered twice.
//
// `buildChart` produces a list of drawing primitives; `toSvg` turns them into a
// standalone file and `drawOn` paints them into a PDF page. Doing it this way
// keeps one layout implementation instead of two, and avoids an SVG-to-PDF
// conversion dependency entirely.
//
// The series plotted is NORMALIZED and indexed to 100 at the window start. Both
// choices are forced by the data: absolute counts differ by three orders of
// magnitude between en and uk, and every edition is losing traffic at its own
// rate, so raw lines would say more about Wikipedia than about the topic.

const PALETTE = ['#1f77b4', '#d62728', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf', '#8c564b', '#e377c2'];

export const colorFor = (i) => PALETTE[i % PALETTE.length];

const niceCeil = (x) => {
  if (x <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(x));
  return Math.ceil(x / mag) * mag;
};

/**
 * Line chart of indexed monthly series.
 * `lines` is [{ label, color, points: [{month, value}] }].
 */
export function buildLineChart({ lines, width = 520, height = 220, title = '' }) {
  const pad = { top: title ? 22 : 8, right: 8, bottom: 26, left: 38 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const ops = [];

  const months = lines[0]?.points.map((p) => p.month) ?? [];
  const values = lines.flatMap((l) => l.points.map((p) => p.value)).filter((v) => Number.isFinite(v));
  const yMax = niceCeil(Math.max(100, ...values) * 1.05);
  const n = Math.max(1, months.length - 1);

  const x = (i) => pad.left + (i / n) * plotW;
  const y = (v) => pad.top + plotH - (Math.max(0, v) / yMax) * plotH;

  if (title) ops.push({ type: 'text', x: pad.left, y: 4, text: title, size: 9, weight: 'bold', fill: '#111' });

  // Horizontal gridlines with labels; 100 is the baseline the index starts from.
  for (const v of [0, yMax / 4, yMax / 2, (3 * yMax) / 4, yMax]) {
    const yy = y(v);
    ops.push({ type: 'line', x1: pad.left, y1: yy, x2: pad.left + plotW, y2: yy, stroke: '#e6e6e6', w: 0.5 });
    ops.push({ type: 'text', x: 2, y: yy - 3.5, text: String(Math.round(v)), size: 7, fill: '#666' });
  }
  if (yMax > 100) {
    const yy = y(100);
    ops.push({ type: 'line', x1: pad.left, y1: yy, x2: pad.left + plotW, y2: yy, stroke: '#999', w: 0.7, dash: [3, 2] });
  }

  // Sparse x labels: first, middle, last, to stay legible at this size.
  for (const i of [...new Set([0, Math.floor(n / 2), n])]) {
    const m = months[i];
    if (!m) continue;
    ops.push({
      type: 'text',
      x: x(i) - 14,
      y: pad.top + plotH + 6,
      text: `${m.slice(0, 4)}-${m.slice(4, 6)}`,
      size: 7,
      fill: '#666',
    });
  }

  for (const line of lines) {
    const pts = line.points
      .map((p, i) => (Number.isFinite(p.value) ? [x(i), y(p.value)] : null))
      .filter(Boolean);
    if (pts.length > 1) ops.push({ type: 'polyline', points: pts, stroke: line.color, w: 1.4 });
  }

  return { width, height, ops, plot: { ...pad, plotW, plotH } };
}

/** Horizontal bars, used for year-over-year change. Zero line is centred. */
export function buildBarChart({ bars, width = 520, height = 150, title = '' }) {
  const pad = { top: title ? 22 : 8, right: 44, bottom: 8, left: 92 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const ops = [];
  if (title) ops.push({ type: 'text', x: 0, y: 4, text: title, size: 9, weight: 'bold', fill: '#111' });

  // Only centre the zero line when the data actually straddles zero. With all
  // values on one side, a centred axis wastes half the width.
  const vals = bars.map((b) => b.value).filter(Number.isFinite);
  const hasPos = vals.some((v) => v > 0);
  const hasNeg = vals.some((v) => v < 0);
  const maxAbs = Math.max(10, ...vals.map(Math.abs));
  const zeroX = hasPos && hasNeg ? pad.left + plotW / 2 : hasNeg ? pad.left + plotW : pad.left;
  const scale = (hasPos && hasNeg ? plotW / 2 : plotW) / maxAbs;
  const rowH = bars.length ? plotH / bars.length : plotH;
  const barH = Math.min(14, rowH * 0.55);

  ops.push({ type: 'line', x1: zeroX, y1: pad.top, x2: zeroX, y2: pad.top + plotH, stroke: '#999', w: 0.7 });

  bars.forEach((b, i) => {
    const cy = pad.top + i * rowH + rowH / 2;
    ops.push({ type: 'text', x: 0, y: cy - 3.5, text: b.label, size: 7.5, fill: '#111' });
    if (!Number.isFinite(b.value)) {
      ops.push({ type: 'text', x: zeroX + 4, y: cy - 3.5, text: 'no data', size: 7, fill: '#999' });
      return;
    }
    const w = Math.abs(b.value) * scale;
    ops.push({
      type: 'rect',
      x: b.value >= 0 ? zeroX : zeroX - w,
      y: cy - barH / 2,
      w: Math.max(0.6, w),
      h: barH,
      fill: b.color,
    });
    const pctText = `${b.value > 0 ? '+' : ''}${Math.round(b.value)}%`;
    ops.push({
      type: 'text',
      x: b.value >= 0 ? Math.min(zeroX + w + 3, width - 30) : Math.max(2, zeroX - w - 28),
      y: cy - 3.5,
      text: pctText,
      size: 7.5,
      fill: '#111',
    });
  });

  return { width, height, ops };
}

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Standalone SVG. Theme-neutral: explicit colours, white plot background. */
export function toSvg(chart, { fontFamily = 'Noto Sans, DejaVu Sans, sans-serif' } = {}) {
  const body = chart.ops
    .map((o) => {
      if (o.type === 'line')
        return `<line x1="${o.x1.toFixed(1)}" y1="${o.y1.toFixed(1)}" x2="${o.x2.toFixed(1)}" y2="${o.y2.toFixed(1)}" stroke="${o.stroke}" stroke-width="${o.w}"${o.dash ? ` stroke-dasharray="${o.dash.join(' ')}"` : ''}/>`;
      if (o.type === 'polyline')
        return `<polyline fill="none" stroke="${o.stroke}" stroke-width="${o.w}" stroke-linejoin="round" points="${o.points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}"/>`;
      if (o.type === 'rect')
        return `<rect x="${o.x.toFixed(1)}" y="${o.y.toFixed(1)}" width="${o.w.toFixed(1)}" height="${o.h.toFixed(1)}" fill="${o.fill}"/>`;
      if (o.type === 'text')
        return `<text x="${o.x.toFixed(1)}" y="${(o.y + o.size).toFixed(1)}" font-size="${o.size}" fill="${o.fill}"${o.weight === 'bold' ? ' font-weight="bold"' : ''}>${esc(o.text)}</text>`;
      return '';
    })
    .join('\n  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${chart.width}" height="${chart.height}" viewBox="0 0 ${chart.width} ${chart.height}" font-family="${fontFamily}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  ${body}
</svg>`;
}

/**
 * Paint a chart into a pdfkit document at (ox, oy).
 * `canRender` lets the caller drop text the embedded font has no glyphs for.
 */
export function drawOn(doc, chart, ox, oy, { regular = 'body', bold = 'bold', canRender = () => true } = {}) {
  for (const o of chart.ops) {
    if (o.type === 'line') {
      doc.save().moveTo(ox + o.x1, oy + o.y1).lineTo(ox + o.x2, oy + o.y2).lineWidth(o.w).strokeColor(o.stroke);
      if (o.dash) doc.dash(o.dash[0], { space: o.dash[1] });
      doc.stroke().undash().restore();
    } else if (o.type === 'polyline') {
      doc.save().lineWidth(o.w).strokeColor(o.stroke).lineJoin('round');
      o.points.forEach(([x, y], i) => (i ? doc.lineTo(ox + x, oy + y) : doc.moveTo(ox + x, oy + y)));
      doc.stroke().restore();
    } else if (o.type === 'rect') {
      doc.save().rect(ox + o.x, oy + o.y, o.w, o.h).fillColor(o.fill).fill().restore();
    } else if (o.type === 'text') {
      const text = canRender(o.text) ? o.text : '';
      if (!text) continue;
      doc.font(o.weight === 'bold' ? bold : regular).fontSize(o.size).fillColor(o.fill).text(text, ox + o.x, oy + o.y, { lineBreak: false });
    }
  }
}
