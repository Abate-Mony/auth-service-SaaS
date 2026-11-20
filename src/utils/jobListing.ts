// Pure helpers behind the Jobs list (getAllJobs / exportJobs). No database
// access here, so they're unit-tested directly (tests/job-listing.test.cjs).

export const escapeRegExp = (input: string): string => input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Assignment statuses that no longer hold a place on the job. */
const RELEASED = new Set(["declined", "cancelled"]);
/** Assignment statuses where the worker has said yes (or is already working it). */
const CONFIRMED = new Set(["accepted", "in-progress", "completed"]);

export interface Staffing {
    required: number;
    /** Accepted, in progress or completed. */
    filled: number;
    /** Invited but not answered yet — holds a place, not confirmed. */
    pending: number;
    /** Places with nobody on them at all (not even invited). */
    open: number;
}

export function staffingFor(requiredWorkers: number | undefined, assignmentStatuses: string[]): Staffing {
    const required = Math.max(1, Number(requiredWorkers) || 1);
    const live = assignmentStatuses.filter(s => !RELEASED.has(s));
    const filled = live.filter(s => CONFIRMED.has(s)).length;
    const pending = live.length - filled;
    return { required, filled, pending, open: Math.max(0, required - live.length) };
}

export type AttentionReason = "unfilled" | "time" | "draft_soon";

interface AttentionJob {
    status: string;
    date: Date;
    startTime: string;
    endTime: string;
    minutes?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Why an upcoming job needs a manager to look at it. Only draft/published
 * jobs dated today or later count — a past or finished job can't be fixed
 * by assigning someone now. `today` is UTC midnight (job.date is stored that way).
 */
export function attentionReasons(job: AttentionJob, staffing: Staffing, today: Date): AttentionReason[] {
    if (job.status !== "draft" && job.status !== "published") return [];
    const jobDay = new Date(job.date).getTime();
    if (jobDay < today.getTime()) return [];
    const reasons: AttentionReason[] = [];
    if (staffing.open > 0) reasons.push("unfilled");
    if (job.startTime === job.endTime || job.minutes === 0) reasons.push("time");
    if (job.status === "draft" && jobDay <= today.getTime() + 2 * DAY_MS) reasons.push("draft_soon");
    return reasons;
}

/**
 * For jobs booked together (multi-day bookings share a bookingGroup), each
 * job's position: "Day 2 of 5". Input: every job in the groups, any order.
 */
export function bookingPositions(groupJobs: { _id: unknown; bookingGroup: string; date: Date }[]) {
    const byGroup = new Map<string, { id: string; time: number }[]>();
    for (const j of groupJobs) {
        const list = byGroup.get(j.bookingGroup) ?? [];
        list.push({ id: String(j._id), time: new Date(j.date).getTime() });
        byGroup.set(j.bookingGroup, list);
    }
    const out = new Map<string, { day: number; of: number }>();
    for (const list of byGroup.values()) {
        list.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
        list.forEach((j, i) => out.set(j.id, { day: i + 1, of: list.length }));
    }
    return out;
}

/** "Repeats weekly", "Repeats every 2 weeks", … */
export function describeRepeat(frequency: string | undefined, interval: number | undefined): string | null {
    if (!frequency) return null;
    const unit = { daily: "day", weekly: "week", monthly: "month" }[frequency];
    if (!unit) return null;
    const n = Number(interval) || 1;
    return n === 1 ? `Repeats ${frequency}` : `Repeats every ${n} ${unit}s`;
}

/** RFC 4180 CSV. Cells that look like formulas are prefixed so spreadsheets don't run them. */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
    const cell = (v: string | number | null | undefined) => {
        let s = v === null || v === undefined ? "" : String(v);
        if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return rows.map(r => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
