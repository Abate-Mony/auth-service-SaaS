// utils/companyEmail.ts
//
// The one place every company-operational email (shift assignments,
// quotes, invoices, ...) goes through to decide who it's actually sent
// as. No feature should resolve a "from" address itself — see
// mailTemplates.ts's sendQuoteEmail/sendInvoiceEmail/sendShiftAssigned for
// the intended call pattern.
import mongoose from "mongoose";
import Company from "../models/company.js";
import { sendMail } from "./sendMailsUtils.js";

// The slim shape every caller actually needs — a full Company doc works
// (structurally compatible), but callers that already have {name, phone}
// selected for something else don't need a second query just to add this.
export interface CompanyEmailInfo {
  name?: string | null;
  emailSettings?: {
    provider?: "inprn" | "custom" | null;
    senderName?: string | null;
    senderEmail?: string | null;
    replyToEmail?: string | null;
    domainStatus?: "not_connected" | "pending" | "verified" | "failed" | null;
  } | null;
}

export interface ResolvedSender {
  from: string;
  replyTo?: string;
  usingCustomDomain: boolean;
}

// A customer's bad DNS configuration must never break operational INPRN
// email — resolveCompanySender has no failure path, only "custom" or
// "fallback". INPRN_FALLBACK_FROM_EMAIL falls back to the pre-existing
// EMAIL_FROM env var so this doesn't require a new deployment config to
// work in every environment that already sends mail today.
const FALLBACK_FROM_EMAIL = process.env.INPRN_FALLBACK_FROM_EMAIL || process.env.EMAIL_FROM || "notifications@inprn.com";

// Custom sending only actually applies once domainStatus is "verified" —
// "pending"/"failed"/removed all silently fall back. This is deliberately
// re-checked here (not just at connect-domain time) so a domain that later
// fails re-verification (or gets removed) can never keep sending under a
// stale "custom" state.
export function resolveCompanySender(company: CompanyEmailInfo | null | undefined): ResolvedSender {
  const settings = company?.emailSettings;
  const canUseCustom =
    settings?.provider === "custom" &&
    settings?.domainStatus === "verified" &&
    !!settings?.senderEmail &&
    !!settings?.senderName;

  if (canUseCustom) {
    return {
      from: `${settings!.senderName} <${settings!.senderEmail}>`,
      replyTo: settings?.replyToEmail || undefined,
      usingCustomDomain: true,
    };
  }

  return {
    from: `INPRN <${FALLBACK_FROM_EMAIL}>`,
    replyTo: settings?.replyToEmail || undefined,
    usingCustomDomain: false,
  };
}

// Convenience overload: most call sites only have a companyId handy (not
// a hydrated company), so this accepts either and fetches when it's just
// an id. Callers that already queried the company for something else
// (name/phone for a PDF, say) should pass the doc directly and add
// "emailSettings" to their own .select() rather than trigger a second query.
export async function sendCompanyEmail(opts: {
  company: CompanyEmailInfo | string | mongoose.Types.ObjectId;
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: { filename: string; content: Buffer }[];
  // Overrides the resolved reply-to for this one send (rare) — the
  // resolved sender's own replyTo is used otherwise.
  replyToOverride?: string;
}): Promise<{ usingCustomDomain: boolean }> {
  const companyDoc =
    typeof opts.company === "string" || opts.company instanceof mongoose.Types.ObjectId
      ? await Company.findById(opts.company).select("name emailSettings").lean()
      : opts.company;

  const sender = resolveCompanySender(companyDoc);

  await sendMail({
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    attachments: opts.attachments,
    from: sender.from,
    replyTo: opts.replyToOverride || sender.replyTo,
  });

  return { usingCustomDomain: sender.usingCustomDomain };
}
