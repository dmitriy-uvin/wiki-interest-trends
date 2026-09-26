// Task 5 — monthly shape glyphs.
//
// A shape carries information a percentage cannot. Spanish "gold mining" reads
// -85%, and its monthly series runs 1,982 -> 1,330 -> 861 -> 238 across Mar-Jun
// 2025 and never recovers. The number alone suggests a market moving; the shape
// shows a break, after which the two halves of the window are not comparable.
//
// The confidence rubric now detects that formally, but the sparkline still earns
// its place: it shows the reader WHY, at a glance, with no threshold to trust.

const BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * Render numbers as block glyphs, scaled to the series' own max.
 * Zero always renders as the lowest bar so the line keeps its length, and gaps
 * (null) render as a space so missing data does not masquerade as zero.
 */
export function sparkline(values) {
  const nums = values.filter((v) => typeof v === 'number');
  if (!nums.length) return '';
  const max = Math.max(...nums);
  if (max <= 0) return BARS[0].repeat(values.length);
  return values
    .map((v) => {
      if (typeof v !== 'number') return ' ';
      const idx = Math.round((v / max) * (BARS.length - 1));
      return BARS[Math.max(0, Math.min(BARS.length - 1, idx))];
    })
    .join('');
}

/** Sparkline of a monthly rollup, most recent on the right. */
export const monthlySparkline = (monthly) => sparkline(monthly.map((m) => m.views));
