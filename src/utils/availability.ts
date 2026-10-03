import mongoose from "mongoose";
import TimeOffRequest from "../models/TimeOffRequest.js";
import WorkerAvailability from "../models/WorkerAvailability.js";
import dayjs from "./dayjsSetup.js";
import { toUtcDay } from "./dates.js";

export type AvailabilityStatus = "available" | "partial" | "unavailable" | "unset";

export interface AvailabilityResult {
    status: AvailabilityStatus;
    reason: string | null;
}

type ShiftLike = { date: Date; startTime: string; endTime: string };

const DAY_NAMES = ["", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];

const toMinutes = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + (m || 0);
};

/** "HH:mm" 00:00–23:59 (24:00 allowed as an end-of-day bound). */
export const isValidTime = (v: unknown): v is string =>
    typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/.test(v);

// job.date is stored as UTC midnight of the shift's own calendar day (see
// toUtcDay), so its UTC weekday *is* the shift's weekday — no timezone
// conversion needed (and doing one would shift it a day for some zones).
const isoWeekdayOf = (date: Date) => dayjs.utc(date).isoWeekday();

/**
 * One worker vs. one shift. Approved time off wins over everything; a
 * pending request is only flagged as partial (it may yet be rejected).
 */
export function evaluateAvailability(
    shift: ShiftLike,
    availability: { days?: { day: number; status?: string | null; start?: string | null; end?: string | null }[] } | null,
    timeOff: { status: string }[]
): AvailabilityResult {
    if (timeOff.some(t => t.status === "approved")) {
        return { status: "unavailable", reason: "On approved time off" };
    }
    const pendingTimeOff = timeOff.some(t => t.status === "pending");

    const weekday = isoWeekdayOf(shift.date);
    const day = availability?.days?.find(d => d.day === weekday);

    let result: AvailabilityResult;
    if (!availability) {
        result = { status: "unset", reason: null };
    } else if (!day || day.status === "available") {
        result = { status: "available", reason: null };
    } else if (day.status === "unavailable") {
        result = { status: "unavailable", reason: `Not available on ${DAY_NAMES[weekday]}` };
    } else {
        // "hours": the whole shift has to fit inside the window. An
        // overnight shift (end before start) runs past midnight, so it can
        // never fit a same-day window.
        const shiftStart = toMinutes(shift.startTime);
        let shiftEnd = toMinutes(shift.endTime);
        if (shiftEnd <= shiftStart) shiftEnd += 24 * 60;
        const fits = !!day.start && !!day.end
            && shiftStart >= toMinutes(day.start)
            && shiftEnd <= toMinutes(day.end);
        result = fits
            ? { status: "available", reason: null }
            : { status: "partial", reason: `Only available ${day.start}–${day.end} on ${DAY_NAMES[weekday]}` };
    }

    if (pendingTimeOff && result.status !== "unavailable") {
        return { status: "partial", reason: "Has requested time off this day" };
    }
    return result;
}

/** Availability of many workers for one shift, keyed by worker id. */
export async function getAvailabilityForShift(
    shift: ShiftLike,
    workerIds: (string | mongoose.Types.ObjectId)[]
): Promise<Map<string, AvailabilityResult>> {
    const day = toUtcDay(shift.date);
    const [availabilities, timeOff] = await Promise.all([
        WorkerAvailability.find({ worker: { $in: workerIds } }).select("worker days").lean(),
        TimeOffRequest.find({
            worker: { $in: workerIds },
            isDeleted: false,
            status: { $in: ["approved", "pending"] },
            startDate: { $lte: day },
            endDate: { $gte: day },
        }).select("worker status").lean(),
    ]);

    const availabilityByWorker = new Map(availabilities.map(a => [a.worker.toString(), a]));
    const result = new Map<string, AvailabilityResult>();
    for (const id of workerIds) {
        const key = id.toString();
        result.set(key, evaluateAvailability(
            shift,
            availabilityByWorker.get(key) ?? null,
            timeOff.filter(t => t.worker.toString() === key)
        ));
    }
    return result;
}
