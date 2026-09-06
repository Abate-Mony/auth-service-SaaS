// services/invoice/calculations.ts
//
// Pure money math — no I/O, no Mongo. Kept in one place so a rate/VAT/due-date
// rule only ever needs changing here, not re-derived at every call site.
import dayjs from "../../utils/dayjsSetup.js";

/** Rounds to 2dp. Money is stored as decimal pounds throughout this app
 *  (not integer pence) — every amount passes through here before it's
 *  persisted, so rounding drift can't accumulate across line items. */
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Confirmed billing model: hourly charge is per WORKER-hour, not per
 * shift-hour. Two workers on one 8-hour job at £30/hour bill as two
 * separate £240 line items (16 worker-hours total), not one £240 job-level
 * line. This function operates on a single worker's minutes accordingly.
 */
export const calculateHourlyAmount = (minutes: number, rate: number): number =>
  round2((minutes / 60) * rate);

/** Fixed-price jobs bill their stored chargeAmount once, regardless of how
 *  many workers it took to cover the shift. */
export const calculateFixedAmount = (chargeAmount: number): number => round2(chargeAmount);

export const calculateVat = (subtotal: number, vatRate: number): number =>
  round2(subtotal * (vatRate / 100));

export const getInvoiceDueDate = (issueDate: Date | string, paymentTermsDays: number): Date =>
  dayjs(issueDate).add(paymentTermsDays, "day").toDate();

export interface LineItemLike {
  amount: number;
}

export const sumLineItems = (lineItems: LineItemLike[]): number =>
  round2(lineItems.reduce((sum, li) => sum + li.amount, 0));
