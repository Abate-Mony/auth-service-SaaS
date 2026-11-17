import { BadRequestError } from "../errors/customErrors.js";
import { toUtcDay } from "./dates.js";

/**
 * "Several days" bookings: a manager picks individual dates (not a repeat
 * pattern) and each becomes its own one-off Job, linked by `bookingGroup`.
 *
 * Payload: `schedule: [{ date: "2026-11-23", startTime: "09:00", endTime: "13:00" }, …]`
 * (array or JSON string). Each day may have its own times.
 */

export const MAX_SCHEDULE_DAYS = 60;

export interface ScheduleDay {
    date: Date; // UTC midnight of the shift day, same as Job.date
    startTime: string;
    endTime: string;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validates and normalises the schedule. Returns null when none was sent. */
export function parseSchedule(raw: unknown, today: Date = new Date()): ScheduleDay[] | null {
    if (raw === undefined || raw === null || raw === "") return null;

    let list: unknown;
    try {
        list = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
        throw new BadRequestError("Invalid schedule payload");
    }
    if (!Array.isArray(list)) throw new BadRequestError("Invalid schedule payload");
    if (list.length === 0) throw new BadRequestError("Pick at least one day");
    if (list.length > MAX_SCHEDULE_DAYS) {
        throw new BadRequestError(`You can book at most ${MAX_SCHEDULE_DAYS} days at once`);
    }

    const todayUtc = toUtcDay(today).getTime();
    const seen = new Set<number>();
    const days: ScheduleDay[] = list.map((d: any, i: number) => {
        const dateStr = typeof d?.date === "string" ? d.date.slice(0, 10) : "";
        if (!DATE_RE.test(dateStr)) throw new BadRequestError(`Day ${i + 1}: invalid date`);
        const date = toUtcDay(dateStr);
        if (Number.isNaN(date.getTime())) throw new BadRequestError(`Day ${i + 1}: invalid date`);
        if (date.getTime() < todayUtc) throw new BadRequestError(`${dateStr} is in the past`);
        if (seen.has(date.getTime())) throw new BadRequestError(`${dateStr} is listed twice`);
        seen.add(date.getTime());

        const { startTime, endTime } = d ?? {};
        if (!TIME_RE.test(startTime ?? "") || !TIME_RE.test(endTime ?? "")) {
            throw new BadRequestError(`${dateStr}: start and finish time are required (HH:mm)`);
        }
        if (startTime === endTime) throw new BadRequestError(`${dateStr}: start and finish can't be the same`);
        return { date, startTime, endTime };
    });

    return days.sort((a, b) => a.date.getTime() - b.date.getTime() || a.startTime.localeCompare(b.startTime));
}

/** "Mon 23, Wed 25, Fri 27 Nov" — or "Mon 30 Nov, Tue 1 Dec" across months; trimmed past 6 days. */
export function describeDays(dates: Date[], fmt: (d: Date, pattern: string) => string): string {
    const parts = dates.map((d, i) => {
        const next = dates[i + 1];
        const monthChanges = !next || fmt(next, "MM") !== fmt(d, "MM");
        return fmt(d, monthChanges ? "ddd D MMM" : "ddd D");
    });
    return parts.length > 6 ? `${parts.slice(0, 5).join(", ")} and ${parts.length - 5} more` : parts.join(", ");
}
