// Task 5 — monthly shape glyphs.
//
// This tiny module does a job that would otherwise need statistics. v1 reports
// raw numbers without quality gating, which means it will happily print
// "Spanish: -85%". That figure is real but its cause is not a market shift: the
// monthly series runs 1,982 -> 1,330 -> 861 -> 238 across Mar-Jun 2025 and never
// recovers, the signature of an article rename or merge sending traffic to a
// different title.
//
// Printing the shape next to the number makes that cliff visible without any
// threshold, detector or judgement call. Transparency instead of cleverness.

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
