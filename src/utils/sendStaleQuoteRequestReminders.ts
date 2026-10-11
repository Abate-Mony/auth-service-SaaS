// A quote created from a public wizard submission (Quote.source ===
// "public_wizard") that's still sitting as an unsent draft after
// REMINDER_DELAY_HOURS almost certainly means nobody on staff has looked
// at it yet — unlike a manually-built draft, which is just a
// work-in-progress someone is actively editing. This nudges the
// company's management-role staff once per quote (reminderSentAt
// stamped on success; left null on failure so the next tick retries),
// same idempotency pattern as sendUpcomingShiftReminders.ts.
import Quote from "../models/quoteModel.js";
import User from "../models/userModel.js";
import Company from "../models/company.js";
import { notifyUser } from "./notifyUser.js";
import { shouldNotify } from "../services/notificationPreferenceService.js";
import { sendQuoteRequestUnaddressedEmail } from "./mailTemplates.js";
import { sendPushToUser } from "./webPush.js";
import { sendExpoPushToUser } from "./expoPush.js";
import { MANAGEMENT_ROLES } from "./roles.js";

const REMINDER_DELAY_HOURS = 24;

// Guards against overlapping runs if a previous tick is still sending mail
// when the next one fires.
let running = false;

export async function sendStaleQuoteRequestReminders() {
  if (running) return;
  running = true;

  try {
    const cutoff = new Date(Date.now() - REMINDER_DELAY_HOURS * 60 * 60 * 1000);

    const dueQuotes = await Quote.find({
      source: "public_wizard",
      status: "draft",
      isDeleted: false,
      reminderSentAt: null,
      createdAt: { $lte: cutoff },
    }).select("company clientSnapshot title total currency quoteNumber");
    if (!dueQuotes.length) return;

    const companyIds = [...new Set(dueQuotes.map(q => q.company.toString()))];
    const [staffByCompany, currencyByCompany] = await Promise.all([
      User.find({ company: { $in: companyIds }, role: { $in: MANAGEMENT_ROLES }, isActive: true })
        .select("company email")
        .then(users => {
          const map = new Map<string, { _id: unknown; email: string }[]>();
          for (const u of users) {
            const key = u.company.toString();
            if (!map.has(key)) map.set(key, []);
            map.get(key)!.push({ _id: u._id, email: u.email });
          }
          return map;
        }),
      Company.find({ _id: { $in: companyIds } })
        .select("currency")
        .then(companies => new Map(companies.map(c => [c._id.toString(), c.currency ?? "GBP"]))),
    ]);

    for (const quote of dueQuotes) {
      const companyKey = quote.company.toString();
      const staff = staffByCompany.get(companyKey) ?? [];
      if (!staff.length) continue;

      const personName = quote.clientSnapshot.name;
      const link = `/quotes/${quote._id}`;
      const currency = currencyByCompany.get(companyKey) ?? "GBP";

      try {
        await Promise.all(
          staff.map(async u => {
            const userId = (u._id as { toString(): string }).toString();
            const [canEmail, canPush] = await Promise.all([
              shouldNotify(userId, "quote_request_unaddressed", "email"),
              shouldNotify(userId, "quote_request_unaddressed", "push"),
            ]);

            await Promise.all([
              notifyUser({
                userId,
                companyId: quote.company,
                event: "quote_request_unaddressed",
                title: "Quote request still unsent",
                body: `${personName}'s request for ${quote.title} hasn't been sent yet`,
                link,
              }),
              canEmail
                ? sendQuoteRequestUnaddressedEmail({
                    staffEmail: u.email,
                    personName,
                    serviceLabel: quote.title,
                    estimateTotal: quote.total,
                    currency,
                    link,
                    company: quote.company,
                  })
                : Promise.resolve(),
              canPush
                ? sendPushToUser(userId, {
                    title: "Quote request still unsent",
                    body: `${personName}'s request for ${quote.title} hasn't been sent yet`,
                    tag: `quote-reminder-${quote._id}`,
                    url: link,
                  })
                : Promise.resolve(),
              canPush
                ? sendExpoPushToUser(userId, {
                    title: "Quote request still unsent",
                    body: `${personName}'s request for ${quote.title} hasn't been sent yet`,
                    tag: `quote-reminder-${quote._id}`,
                    url: link,
                  })
                : Promise.resolve(),
            ]);
          })
        );
        quote.reminderSentAt = new Date();
        await quote.save();
      } catch (err) {
        console.error(`Failed to send stale-quote reminder for quote ${quote._id}:`, err);
        // reminderSentAt stays unset so the next tick retries this one
      }
    }
  } finally {
    running = false;
  }
}
