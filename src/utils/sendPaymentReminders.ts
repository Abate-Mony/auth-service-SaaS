// utils/sendPaymentReminders.ts
//
// Daily job: nudges clients about invoices that are now overdue. Each
// invoice gets reminded at most once per milestone in REMINDER_DAYS
// (tracked on Invoice.remindersSent), so this can run every day without
// spamming — and if the job is ever down for a few days, it catches up by
// sending the single highest milestone actually reached, not one email per
// day missed.
import Invoice from "../models/invoiceModel.js";
import Company from "../models/company.js";
import dayjs from "./dayjsSetup.js";
import { sendPaymentReminderEmail } from "./mailTemplates.js";

const REMINDER_DAYS = [3, 7, 14, 30];

let running = false;

export async function sendOverduePaymentReminders() {
  if (running) return;
  running = true;

  try {
    const now = new Date();

    const invoices = await Invoice.find({
      status: "sent",
      dueDate: { $lt: now },
    }).select("invoiceNumber company clientSnapshot total amountPaid dueDate currency remindersSent");

    if (!invoices.length) return;

    const companyIds = [...new Set(invoices.map(inv => inv.company.toString()))];
    const companies = await Company.find({ _id: { $in: companyIds } }).select(
      "name emailSettings paymentRemindersEnabled"
    );
    const companyById = new Map(companies.map(c => [c._id.toString(), c]));

    for (const inv of invoices) {
      const balanceDue = Math.max(0, (inv.total ?? 0) - (inv.amountPaid ?? 0));
      if (balanceDue <= 0) continue;

      const company = companyById.get(inv.company.toString());
      if (!company || company.paymentRemindersEnabled === false) continue;

      const email = inv.clientSnapshot?.billingEmail;
      if (!email) continue;

      const daysOverdue = dayjs(now).diff(dayjs(inv.dueDate), "day");
      const alreadySent = new Set(inv.remindersSent ?? []);
      // Highest milestone reached that hasn't fired yet — not the lowest,
      // so a gap in the job's own uptime doesn't queue up several emails.
      const milestone = [...REMINDER_DAYS].reverse().find(d => daysOverdue >= d && !alreadySent.has(d));
      if (milestone === undefined) continue;

      try {
        await sendPaymentReminderEmail({
          to: email,
          company,
          clientContactName: inv.clientSnapshot?.contactName,
          invoiceNumber: inv.invoiceNumber,
          balanceDue,
          currency: inv.currency ?? "GBP",
          dueDate: inv.dueDate,
          daysOverdue,
        });
        inv.remindersSent = [...alreadySent, milestone];
        await inv.save();
      } catch (err) {
        console.error(`Failed to send payment reminder for invoice ${inv.invoiceNumber}:`, err);
      }
    }
  } finally {
    running = false;
  }
}
