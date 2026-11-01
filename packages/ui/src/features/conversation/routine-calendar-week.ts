/** The week view shows at least this many hour rows, so a week with one routine is not a thin strip. */
const MIN_HOUR_ROWS = 8;
/** A week with no routine shows the working day. */
const EMPTY_WEEK = { first: 8, last: 17 } as const;

/** The hour rows of a week: from the first hour that has a run to the last, grown to the minimum. */
export function weekHourRange(hours: readonly number[]): { first: number; last: number } {
  if (hours.length === 0) return { ...EMPTY_WEEK };
  let first = Math.min(...hours);
  let last = Math.max(...hours);
  while (last - first + 1 < MIN_HOUR_ROWS) {
    if (last < 23) last += 1;
    else if (first > 0) first -= 1;
    else break;
  }
  return { first, last };
}
