// Pure formatting helpers for the timesheet PDF (timesheetPdf.ts). No I/O,
// so they're unit-tested directly (tests/timesheet-format.test.cjs).

import { tidyAddress } from "./addressFormat.js";

const COUNTRY = /^(uk|u\.k\.|united kingdom|england|great britain|gb)$/i;
// A part that's essentially just a phone number ("07479391536", "+44 7479 391536").
const PHONE = /^\+?[\d\s()-]{9,}$/;

/**
 * One tidy address line for printing, from a job's site name, location and
 * address: repeats removed (tidyAddress), plus countries and phone numbers
 * dropped since they're noise on a timesheet.
 */
export function cleanAddress(...sources: (string | null | undefined)[]): string {
    const joined = sources
        .filter((s): s is string => !!s && s.trim() !== "" && s.trim() !== "—")
        .flatMap(s => s.split(","))
        .map(p => p.trim())
        .filter(p => p && !COUNTRY.test(p) && !PHONE.test(p))
        .join(", ");
    return tidyAddress(joined);
}

/** Strip the "(Copy)" suffix duplicating a job used to add. */
export const cleanJobTitle = (title: string) =>
    (title ?? "").replace(/(\s*\(copy\))+\s*$/i, "").trim() || title;

/** Monday (YYYY-MM-DD) of the ISO week a "YYYY-MM-DD" day falls in. */
export function weekStartOf(dayKey: string): string {
    const [y, m, d] = dayKey.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    const dow = (date.getUTCDay() + 6) % 7; // Mon = 0
    date.setUTCDate(date.getUTCDate() - dow);
    return date.toISOString().slice(0, 10);
}

/** "£13.00/h", or "£12.00–£14.50/h" when the period mixes rates. */
export function describeRates(rates: number[], symbol: string): string | null {
    const known = [...new Set(rates.filter(r => Number.isFinite(r) && r > 0))].sort((a, b) => a - b);
    if (!known.length) return null;
    const fmt = (n: number) => `${symbol}${n.toFixed(2)}`;
    return known.length === 1 ? `${fmt(known[0])}/h` : `${fmt(known[0])}–${fmt(known[known.length - 1])}/h`;
}

/** Decimal hours, 2dp — the same format payroll uses. */
export const hoursDecimal = (minutes: number) => (Math.max(0, minutes) / 60).toFixed(2);
