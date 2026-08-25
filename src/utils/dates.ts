// utils/dates.ts

/**
 * Normalises any date input to UTC midnight.
 * Every Job.date is written through this, and every date-range query
 * compares against it — that's what stops occurrences landing at
 * T23:00:00Z and rendering a day early.
 */
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
dayjs.extend(timezone);
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
// utils/dates.ts

/** The moment a shift is scheduled to begin, in UTC. */
export const TZ = "Europe/London";
export const scheduledStartOf = (
  job: { date: Date | string; startTime: string },
  timezone = TZ
): Date => {
  const [h, m] = job.startTime.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) {
    throw new Error(`Invalid startTime: ${job.startTime}`);
  }
  const day = dayjs.utc(job.date).format("YYYY-MM-DD");
  return dayjs.tz(`${day} ${job.startTime}`, timezone).toDate();
};

export const scheduledEndOf = (
  job: { date: Date | string; startTime: string; minutes: number },
  timezone = TZ
): Date => {
  return new Date(scheduledStartOf(job, timezone).getTime() + job.minutes * 60_000);
};
// utils/dates.ts i
