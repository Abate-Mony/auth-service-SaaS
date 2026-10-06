// utils/checkPendingEmailDomains.ts
//
// Runs every 10 minutes (see server.ts): re-checks any company's sending
// domain still stuck in "pending" against Resend, so a domain that
// finishes DNS propagation gets picked up automatically instead of only
// flipping to "verified" the next time someone happens to open the Email
// Settings page (getEmailSettings's own opportunistic check) or clicks
// "Check DNS" themselves. Exists because of a real gap: an operational
// email (shift assignment, quote, ...) sent in that window would silently
// fall back to OnClockly's own address even though the domain was, in
// practice, about to be ready.
//
// Deliberately scoped to "pending" only, not "failed" — a failed domain
// usually means a real DNS misconfiguration that won't fix itself, and
// polling it every 10 minutes forever would just burn Resend API calls
// for no benefit. "Failed" domains still get re-checked whenever the
// owner opens Settings or clicks "Check DNS" manually.
//
// A GET (fetchResendDomain), not a verify-then-fetch — Resend re-checks
// DNS on its own side continuously; this only needs to read the current
// state, not force a fresh check every single run.
import Company from "../models/company.js";
import { fetchResendDomain } from "./resendDomain.js";

let running = false;

export async function checkPendingEmailDomains() {
  if (running) return;
  running = true;

  try {
    const companies = await Company.find({
      "emailSettings.provider": "custom",
      "emailSettings.domainStatus": "pending",
      "emailSettings.resendDomainId": { $exists: true, $ne: "" },
    }).select("emailSettings");

    for (const company of companies) {
      const settings = company.emailSettings as any;
      try {
        const fetched = await fetchResendDomain(settings.resendDomainId);
        if (fetched.status === settings.domainStatus) continue;

        settings.domainStatus = fetched.status;
        settings.lastVerificationCheckAt = new Date();
        if (fetched.status === "verified" && !settings.verifiedAt) settings.verifiedAt = new Date();

        company.emailSettings = settings;
        await company.save();
      } catch (err) {
        // One company's provider hiccup must never stop the rest of the
        // batch from being checked.
        console.error(`checkPendingEmailDomains: failed to check domain for company ${company._id}:`, err);
      }
    }
  } finally {
    running = false;
  }
}
