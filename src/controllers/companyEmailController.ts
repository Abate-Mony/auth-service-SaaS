import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { getReqUser, MiddlewareFn } from "../interfaces/expresstype.js";
import Company from "../models/company.js";
import { resolveCompanySender, sendCompanyEmail } from "../utils/companyEmail.js";
import {
    createResendDomain,
    fetchResendDomain,
    removeResendDomain,
    triggerResendDomainVerification,
    type DnsRecordDto,
} from "../utils/resendDomain.js";

const parseOrThrow = <T>(schema: z.ZodSchema<T>, body: unknown): T => {
    try {
        return schema.parse(body);
    } catch (err) {
        if (err instanceof z.ZodError) {
            throw new BadRequestError(err.issues.map(i => `${i.path.join(".") || "value"}: ${i.message}`).join("; "));
        }
        throw err;
    }
};

// Rejects protocols, paths, query strings and email addresses so a
// company can't accidentally (or maliciously) connect anything other
// than a bare domain — see the brief's exact reject list.
const domainSchema = z
    .string()
    .trim()
    .toLowerCase()
    .refine(v => !v.includes("://"), "Enter just the domain, not a URL.")
    .refine(v => !v.includes("@"), "Enter a domain, not an email address.")
    .refine(v => !v.includes("/") && !v.includes("?"), "Enter just the domain, without a path.")
    .refine(
        v => /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(v),
        "Enter a valid domain, e.g. mail.yourcompany.com."
    );

const connectDomainSchema = z.object({ domain: domainSchema }).strict();

// Mailbox-name subset only — the domain half is never taken from the
// frontend (see updateEmailSettings below), so a company can't type a
// sender on a domain it doesn't control.
const localPartSchema = z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Enter a sender name for the address.")
    .max(64, "Keep the sender address under 64 characters.")
    .regex(/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/, "Use only letters, numbers, dots, hyphens or underscores.");

const updateSettingsSchema = z
    .object({
        senderName: z.string().trim().max(150).optional(),
        replyToEmail: z.union([z.string().trim().toLowerCase().email("Enter a valid reply-to email."), z.literal("")]).optional(),
        senderLocalPart: localPartSchema.optional(),
    })
    .strict();

const testEmailSchema = z.object({ email: z.string().trim().toLowerCase().email("Enter a valid email address.") }).strict();

// The one place the frontend's response shape is decided — resendDomainId
// never appears here even though it's a normal (not select:false) model
// field, and any future emailSettings field is safe-by-default until
// someone deliberately adds it to this list.
function serializeEmailSettings(emailSettings: any) {
    const s = emailSettings ?? {};
    return {
        provider: s.provider ?? "inprn",
        senderName: s.senderName ?? "",
        senderEmail: s.senderEmail ?? "",
        replyToEmail: s.replyToEmail ?? "",
        sendingDomain: s.sendingDomain ?? "",
        domainStatus: s.domainStatus ?? "not_connected",
        verifiedAt: s.verifiedAt ?? null,
        lastVerificationCheckAt: s.lastVerificationCheckAt ?? null,
    };
}

// GET /companies/email-settings — any admin+ can view (route-gated);
// only the owner can mutate anything below. Opportunistically refreshes
// from the provider while a domain is still outstanding, so opening the
// settings page alone can surface a "verified" flip without an explicit
// "Check DNS" click.
export const getEmailSettings: MiddlewareFn = async (req, res) => {
    const companyId = getReqUser(req).company_id;
    const company = await Company.findById(companyId).select("emailSettings");
    if (!company) throw new NotFoundError("Company not found.");

    const settings = (company.emailSettings ?? {}) as any;
    let dnsRecords: DnsRecordDto[] = [];

    if (settings.resendDomainId && settings.domainStatus !== "verified") {
        try {
            const fetched = await fetchResendDomain(settings.resendDomainId);
            dnsRecords = fetched.records;
            if (fetched.status !== settings.domainStatus) {
                settings.domainStatus = fetched.status;
                settings.lastVerificationCheckAt = new Date();
                if (fetched.status === "verified" && !settings.verifiedAt) settings.verifiedAt = new Date();
                company.emailSettings = settings;
                await company.save();
            }
        } catch {
            // A provider hiccup shouldn't fail the whole settings page —
            // fall through and return the last known local state.
        }
    }

    res.status(StatusCodes.OK).json({ success: true, settings: serializeEmailSettings(settings), dnsRecords });
};

// PATCH /companies/email-settings — owner-only (route-gated). Handles the
// plain sender-identity fields AND, when senderLocalPart is given,
// constructing the actual verified-domain sender address server-side —
// never trusts a full frontend-provided sender email.
export const updateEmailSettings: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(updateSettingsSchema, req.body);
    if (Object.keys(data).length === 0) throw new BadRequestError("No valid fields provided.");

    const companyId = getReqUser(req).company_id;
    const company = await Company.findById(companyId).select("emailSettings");
    if (!company) throw new NotFoundError("Company not found.");

    const settings = (company.emailSettings ?? {}) as any;

    if (data.senderName !== undefined) settings.senderName = data.senderName;
    if (data.replyToEmail !== undefined) settings.replyToEmail = data.replyToEmail;

    if (data.senderLocalPart !== undefined) {
        if (settings.provider !== "custom" || settings.domainStatus !== "verified" || !settings.sendingDomain) {
            throw new BadRequestError("Connect and verify a sending domain before setting a sender address.");
        }
        settings.senderEmail = `${data.senderLocalPart}@${settings.sendingDomain}`;
    }

    company.emailSettings = settings;
    await company.save();

    res.status(StatusCodes.OK).json({ success: true, settings: serializeEmailSettings(settings) });
};

// POST /companies/email-domain — owner-only. One domain per company at a
// time in v1 — an existing connected domain must be explicitly removed
// (DELETE) before another can be connected, never silently replaced.
export const connectEmailDomain: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(connectDomainSchema, req.body);
    const companyId = getReqUser(req).company_id;

    const company = await Company.findById(companyId).select("emailSettings");
    if (!company) throw new NotFoundError("Company not found.");

    const existing = (company.emailSettings ?? {}) as any;
    if (existing.resendDomainId) {
        throw new BadRequestError(
            "A sending domain is already connected. Remove it before connecting another.",
            "DOMAIN_ALREADY_CONNECTED"
        );
    }

    const created = await createResendDomain(data.domain);

    const settings = {
        ...existing,
        provider: "custom",
        sendingDomain: data.domain,
        resendDomainId: created.resendDomainId,
        domainStatus: created.status,
        verifiedAt: null,
        lastVerificationCheckAt: new Date(),
    };
    company.emailSettings = settings as any;
    await company.save();

    res.status(StatusCodes.CREATED).json({
        success: true,
        settings: serializeEmailSettings(settings),
        dnsRecords: created.records,
    });
};

// POST /companies/email-domain/verify — owner-only. Re-checks with the
// provider and refreshes local state; the backend stays the source of
// truth the frontend reads back, never the provider's raw response.
export const verifyEmailDomain: MiddlewareFn = async (req, res) => {
    const companyId = getReqUser(req).company_id;
    const company = await Company.findById(companyId).select("emailSettings");
    if (!company) throw new NotFoundError("Company not found.");

    const settings = (company.emailSettings ?? {}) as any;
    if (!settings.resendDomainId) throw new BadRequestError("No sending domain is connected yet.");

    await triggerResendDomainVerification(settings.resendDomainId);
    const fetched = await fetchResendDomain(settings.resendDomainId);

    settings.domainStatus = fetched.status;
    settings.lastVerificationCheckAt = new Date();
    if (fetched.status === "verified" && !settings.verifiedAt) settings.verifiedAt = new Date();

    company.emailSettings = settings;
    await company.save();

    res.status(StatusCodes.OK).json({
        success: true,
        settings: serializeEmailSettings(settings),
        dnsRecords: fetched.records,
    });
};

// DELETE /companies/email-domain — owner-only. Falls back to the INPRN
// sender immediately: resolveCompanySender re-checks domainStatus on
// every send regardless, but this also clears the sender address itself
// so nothing in Settings looks half-configured afterward. senderName and
// replyToEmail are preserved — a company's chosen display name and
// reply-to don't stop making sense just because the domain is gone.
export const removeEmailDomain: MiddlewareFn = async (req, res) => {
    const companyId = getReqUser(req).company_id;
    const company = await Company.findById(companyId).select("emailSettings");
    if (!company) throw new NotFoundError("Company not found.");

    const existing = (company.emailSettings ?? {}) as any;

    if (existing.resendDomainId) {
        try {
            await removeResendDomain(existing.resendDomainId);
        } catch {
            // Provider-side removal failing must not block clearing INPRN's
            // own state — a domain Resend still holds that this company can
            // no longer reach is strictly worse than a stray provider record.
        }
    }

    const settings = {
        provider: "inprn",
        senderName: existing.senderName ?? "",
        senderEmail: "",
        replyToEmail: existing.replyToEmail ?? "",
        sendingDomain: "",
        resendDomainId: "",
        domainStatus: "not_connected",
        verifiedAt: null,
        lastVerificationCheckAt: null,
    };
    company.emailSettings = settings as any;
    await company.save();

    res.status(StatusCodes.OK).json({ success: true, settings: serializeEmailSettings(settings) });
};

// POST /companies/email-domain/test — owner-only.
export const sendTestEmail: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(testEmailSchema, req.body);
    const companyId = getReqUser(req).company_id;

    const company = await Company.findById(companyId).select("name emailSettings").lean();
    if (!company) throw new NotFoundError("Company not found.");

    const sender = resolveCompanySender(company);

    const html = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;max-width:480px;margin:0 auto;color:#0F172A;">
        <h2 style="font-size:18px;margin:0 0 12px;">Your email sending is set up</h2>
        <p style="font-size:14px;color:#475569;margin:0 0 16px;">This is a test email from INPRN — your configuration is working.</p>
        <table style="width:100%;border-collapse:collapse;background:#F8FAFC;border-radius:12px;padding:4px 16px;">
          <tr><td style="padding:8px 0;font-size:13px;color:#94A3B8;width:90px;">Sender</td><td style="padding:8px 0;font-size:14px;color:#0F172A;font-weight:600;">${sender.from}</td></tr>
          ${sender.replyTo ? `<tr><td style="padding:8px 0;font-size:13px;color:#94A3B8;">Reply-to</td><td style="padding:8px 0;font-size:14px;color:#0F172A;font-weight:600;">${sender.replyTo}</td></tr>` : ""}
        </table>
      </div>`;

    await sendCompanyEmail({
        company,
        to: data.email,
        subject: "INPRN email setup test",
        text:
            `Your INPRN email sending configuration is working.\n\n` +
            `Sender: ${sender.from}\n` +
            (sender.replyTo ? `Reply-to: ${sender.replyTo}\n` : ""),
        html,
    });

    res.status(StatusCodes.OK).json({ success: true, usingCustomDomain: sender.usingCustomDomain, sender: sender.from });
};
