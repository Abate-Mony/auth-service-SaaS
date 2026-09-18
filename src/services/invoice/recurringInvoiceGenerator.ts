// services/invoice/recurringInvoiceGenerator.ts
//
// Daily job: for companies that have opted in (Company.
// autoGenerateRecurringInvoices), automatically drafts an invoice for any
// client whose billing cadence (Client.billingFrequency/billingDayOfWeek/
// billingDayOfMonth) has just closed a period — the same eligible-work
// logic the manual "create invoice" flow uses (createDraftInvoice.ts),
// just triggered by the calendar instead of a manager's click.
//
// Deliberately opt-in per company, not automatic the moment a client gets
// a billingFrequency: that field already existed purely as a UI hint for
// the manual eligible-work picker, so turning it into a live trigger for
// every existing company without warning would auto-generate invoices
// nobody asked for yet.
//
// Always creates a DRAFT, never auto-sends — a generated invoice still
// needs a human to review the amounts and hit Send, same "AI/automation
// drafts, a person confirms" principle as the job-draft assistant and the
// quote flow elsewhere in this app.
import mongoose from "mongoose";
import Client from "../../models/clientModel.js";
import Company from "../../models/company.js";
import Invoice from "../../models/invoiceModel.js";
import dayjs from "../../utils/dayjsSetup.js";
import { computeCurrentBillingPeriod, type BillingPeriod } from "./billingPeriod.js";
import { getEligibleWork } from "./eligibility.js";
import { createDraftInvoice } from "./createDraftInvoice.js";

const RECURRING_FREQUENCIES = ["weekly", "fortnightly", "monthly"] as const;

interface LeanRecurringClient {
  _id: mongoose.Types.ObjectId;
  company: mongoose.Types.ObjectId;
  billingFrequency: string;
  billingDayOfWeek?: number;
  billingDayOfMonth?: number;
}

// Weekly/fortnightly: a period's own `end` date IS the trigger day (that's
// how billingDayOfWeek is defined — see billingPeriod.ts), so "yesterday
// was the last day of its period" is exactly "today is the day after
// billingDayOfWeek" — no separate date math needed, just re-use the period
// calculation anchored on yesterday.
//
// Monthly: billingDayOfMonth is deliberately a different concept (when to
// ISSUE, not where the period starts/ends — see billingPeriod.ts's own
// comment), so this bills the calendar month that just ended once today's
// day-of-month reaches billingDayOfMonth.
function periodDueToday(client: LeanRecurringClient, today: Date): BillingPeriod | null {
  const freq = client.billingFrequency;

  if (freq === "weekly" || freq === "fortnightly") {
    const yesterday = dayjs.utc(today).subtract(1, "day").toDate();
    const period = computeCurrentBillingPeriod(freq, client.billingDayOfWeek, client.billingDayOfMonth, yesterday);
    if (!period) return null;
    return dayjs.utc(period.end).isSame(dayjs.utc(yesterday), "day") ? period : null;
  }

  if (freq === "monthly") {
    const dayOfMonth = client.billingDayOfMonth ?? 1;
    if (dayjs.utc(today).date() !== dayOfMonth) return null;
    const prevMonth = dayjs.utc(today).subtract(1, "month");
    return { start: prevMonth.startOf("month").toDate(), end: prevMonth.endOf("month").toDate() };
  }

  return null;
}

let running = false;

export async function generateRecurringInvoices() {
  if (running) return;
  running = true;

  try {
    const companies = await Company.find({ autoGenerateRecurringInvoices: true, isActive: true })
      .select("_id owner currency")
      .lean();
    if (!companies.length) return;

    const today = new Date();
    const companyIds = companies.map(c => c._id);

    const clients = await Client.find({
      company: { $in: companyIds },
      isDeleted: false,
      status: "active",
      billingFrequency: { $in: RECURRING_FREQUENCIES },
    })
      .select("company billingFrequency billingDayOfWeek billingDayOfMonth")
      .lean<LeanRecurringClient[]>();

    const companyById = new Map(companies.map(c => [c._id.toString(), c]));

    for (const client of clients) {
      const period = periodDueToday(client, today);
      if (!period) continue;

      const company = companyById.get(client.company.toString());
      if (!company) continue;

      // A client billed weekly/monthly that already has an invoice
      // covering exactly this period (e.g. a manager already generated it
      // by hand before the job ran today) needs nothing further — checked
      // up front so a company with no eligible work isn't queried twice.
      const alreadyInvoiced = await Invoice.exists({
        company: company._id,
        client: client._id,
        isDeleted: false,
        status: { $ne: "cancelled" },
        "servicePeriod.start": period.start,
        "servicePeriod.end": period.end,
      });
      if (alreadyInvoiced) continue;

      try {
        const eligible = await getEligibleWork(company._id.toString(), client._id.toString(), period.start, period.end);
        // Nothing to bill this period — not an error, just skip. A
        // client with genuinely no work in a given week/month shouldn't
        // get a £0 invoice.
        if (eligible.items.length === 0) continue;

        const jobIds = [...new Set(eligible.items.filter(i => !i.assignmentId).map(i => i.jobId))];
        const assignmentIds = eligible.items.filter(i => i.assignmentId).map(i => i.assignmentId as string);

        await createDraftInvoice({
          companyId: company._id,
          createdBy: company.owner,
          clientId: client._id.toString(),
          periodStart: period.start,
          periodEnd: period.end,
          jobIds,
          assignmentIds,
        });
      } catch (err) {
        console.error(
          `Failed to auto-generate recurring invoice for client ${client._id} (company ${company._id}):`,
          err
        );
      }
    }
  } finally {
    running = false;
  }
}
