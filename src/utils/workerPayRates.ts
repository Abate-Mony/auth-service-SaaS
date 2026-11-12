import { BadRequestError } from "../errors/customErrors.js";

/**
 * Per-worker pay rates on a job.
 *
 * A job has one default `payRate`. Any assigned worker can optionally be paid
 * something different: the create/update payload marks that by sending
 * `customPayRate` on that worker's entry —
 *
 *     workers: [{ email: "a@x.com" }, { email: "b@x.com", customPayRate: 15 }]
 *
 * A dedicated key (not `payRate`) on purpose: the edit form can resend
 * populated assignment objects that already carry the assignment's stored
 * `payRate`, and that must not be mistaken for a deliberate override.
 *
 * The assignment stores the rate actually paid in `payRate` (what reports,
 * timesheets and invoices already read) plus `payRateIsCustom`, so a later
 * change to the job's default only moves the workers who are on the default.
 */

const emailOf = (w: any): string | undefined => w?.email ?? w?.worker?.email;

/** email → custom rate, for the entries that carry one. Throws on a bad value. */
export function parseCustomPayRates(workers: any[]): Map<string, number> {
    const rates = new Map<string, number>();
    for (const w of workers) {
        const email = emailOf(w);
        const raw = w?.customPayRate;
        if (!email || raw === undefined || raw === null || raw === "") continue;
        const rate = typeof raw === "string" ? Number(raw) : raw;
        if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) {
            throw new BadRequestError(`Invalid pay rate for ${email} — must be a number of 0 or more`);
        }
        rates.set(email, Math.round(rate * 100) / 100);
    }
    return rates;
}

/** The pay fields to store on one worker's assignment. */
export function assignmentPay(defaultRate: number, customRate: number | undefined) {
    return customRate === undefined
        ? { payRate: defaultRate, payRateIsCustom: false }
        : { payRate: customRate, payRateIsCustom: true };
}
