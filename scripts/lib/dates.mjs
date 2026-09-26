// Date helpers. The pageviews API uses YYYYMMDD strings and UTC day boundaries,
// so everything here stays in UTC and in that string form to avoid timezone drift.

export const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
export const parse = (s) =>
  new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8) || 1));
export const iso = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
export const addDays = (s, n) => {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
};
/**
 * Add months, clamping the day to the target month's length. Plain
 * setUTCMonth turns 2026-01-31 + 1 into 2026-03-03, which would quietly shift a
 * window's edge by a few days.
 */
export const addMonths = (s, n) => {
  const d = parse(s);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return fmt(d);
};
export const monthStart = (s) => `${s.slice(0, 6)}01`;
export const today = () => fmt(new Date());

/** Daily pageview data lags about a day; asking beyond it yields silent gaps. */
export const DATA_LAG_DAYS = 2;
export const latestDailyAvailable = () => addDays(today(), -DATA_LAG_DAYS);

/**
 * The last month that is actually complete. The API happily returns the current
 * month as a partial total (Sep 2026 came back with 25 days of data), which reads
 * as a sudden collapse if compared against full months.
 */
export function lastCompleteMonth(ref = today()) {
  return monthStart(addMonths(monthStart(ref), -1));
}

/** Last calendar day of the month containing `s`. */
export const endOfMonth = (s) => {
  const d = parse(s);
  return fmt(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
};

/**
 * A window of exactly `n` COMPLETE months, ending with the last complete month.
 *
 * Analysis windows are defined this way rather than as "the last 730 days"
 * because a partial month at either end quietly distorts every comparison, and
 * project totals (the normalization denominator) only exist for whole months.
 */
export function completeMonthWindow(n) {
  const lastMonth = lastCompleteMonth();
  return { from: monthStart(addMonths(lastMonth, -(n - 1))), to: endOfMonth(lastMonth), months: n };
}

/** "2y" / "18m" / "90d" expressed as a whole number of months. */
export function sinceToMonths(since) {
  const m = /^(\d+)([dmy])$/.exec(String(since).trim());
  if (!m) throw new Error(`Bad --since value "${since}". Use forms like 6m, 18m, 2y.`);
  const n = +m[1];
  if (m[2] === 'y') return 12 * n;
  if (m[2] === 'm') return n;
  return Math.max(1, Math.round(n / 30));
}

export function eachDay(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** "2y", "18m", "90d" -> a start date relative to `end`. */
export function sinceToStart(since, end) {
  const m = /^(\d+)([dmy])$/.exec(String(since).trim());
  if (!m) throw new Error(`Bad --since value "${since}". Use forms like 90d, 18m, 2y.`);
  const n = +m[1];
  if (m[2] === 'd') return addDays(end, -n);
  if (m[2] === 'm') return addMonths(end, -n);
  return addMonths(end, -12 * n);
}

/** Pageview data does not exist before this date. */
export const DATA_FLOOR = '20150701';
