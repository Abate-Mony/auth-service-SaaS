// utils/dates.ts

/**
 * Normalises any date input to UTC midnight.
 * Every Job.date is written through this, and every date-range query
 * compares against it — that's what stops occurrences landing at
 * T23:00:00Z and rendering a day early.
 */
export const toUtcDay = (input: string | Date): Date => {
  if (typeof input === "string") {
    const d = new Date(`${input.slice(0, 10)}T00:00:00.000Z`);
    if (isNaN(d.getTime())) throw new Error(`Invalid date: ${input}`);
    return d;
  }
  if (isNaN(input.getTime())) throw new Error(`Invalid date: ${input}`);
  return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
};

/** "YYYY-MM-DD" for a stored date, read as UTC. Use for keying/comparing days. */
export const toUtcDayKey = (input: string | Date): string =>
  toUtcDay(input).toISOString().slice(0, 10);

/** Exclusive upper bound for a date-range query covering `end` in full. */
export const endOfUtcDayExclusive = (input: string | Date): Date => {
  const d = toUtcDay(input);
  return new Date(d.getTime() + 24 * 60 * 60 * 1000);
};