// services/invoice/billingPeriod.ts
//
// Turns a Client's billing schedule (billingFrequency + billingDayOfWeek /
// billingDayOfMonth) into an actual date range — "the current billing
// period" a manager would generate one invoice for. Billing frequency is
// just the default grouping window for eligible work, not a different kind
// of invoice (see the eligible-work service's own note on that split), so
// this stays a pure date calculation with no invoicing logic in it.
import dayjs from "../../utils/dayjsSetup.js";

export interface BillingPeriod {
  start: Date;
  end: Date;
}

// A fixed, arbitrary Monday used only to anchor fortnightly blocks to a
// stable global grid — so "which 14-day block is today in" gives the same
// answer regardless of when a given client was created.
const FORTNIGHT_EPOCH = dayjs.utc("2024-01-01");

/**
 * The billing period currently "open" (containing `anchor`, default today).
 * Returns null for per_job/manual clients — there's no fixed grouping
 * window for those, the manager just picks jobs or a custom range.
 */
export const computeCurrentBillingPeriod = (
  frequency: string | undefined,
  billingDayOfWeek: number | undefined,
  billingDayOfMonth: number | undefined,
  anchor: Date = new Date()
): BillingPeriod | null => {
  const a = dayjs(anchor);

  switch (frequency) {
    case "weekly": {
      const endDow = billingDayOfWeek ?? 0; // Sunday by default
      let end = a.day(endDow);
      if (end.isBefore(a, "day")) end = end.add(7, "day");
      const start = end.subtract(6, "day");
      return { start: start.startOf("day").toDate(), end: end.endOf("day").toDate() };
    }
    case "fortnightly": {
      const daysSinceEpoch = a.startOf("day").diff(FORTNIGHT_EPOCH, "day");
      const blockIndex = Math.floor(daysSinceEpoch / 14);
      const start = FORTNIGHT_EPOCH.add(blockIndex * 14, "day");
      return { start: start.startOf("day").toDate(), end: start.add(13, "day").endOf("day").toDate() };
    }
    case "monthly": {
      // billingDayOfMonth (when relevant) is when the invoice goes out, not
      // where the period starts — the period itself stays the calendar
      // month, matching the client-facing "1 Sep – 30 Sep" mental model.
      return { start: a.startOf("month").toDate(), end: a.endOf("month").toDate() };
    }
    case "per_job":
    case "manual":
    default:
      return null;
  }
};
