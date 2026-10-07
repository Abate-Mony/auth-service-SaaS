// Public, unauthenticated endpoints behind a company's quote-request link
// (quotes.onclockly.com/<publicQuoteSlug> — see utils/publicSlug.ts and
// Company.publicQuoteSlug). A visitor filling in the wizard becomes a Lead
// (Client with lifecycle: "lead"), the same model/pipeline the in-app
// Leads CRM already runs on — see leadController.ts.
import { StatusCodes } from "http-status-codes";
import mongoose from "mongoose";
import { z } from "zod";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import Company from "../models/company.js";
import Client from "../models/clientModel.js";
import QuoteWorkflow, { type QuoteWorkflowServiceType } from "../models/quoteWorkflowModel.js";
import { computeServiceEstimate, type ComputedEstimate } from "../services/quoteWorkflow/estimatePrice.js";
import { createQuoteFromLeadIntake } from "../services/quote/createQuoteFromLeadIntake.js";
import { sendQuoteNow } from "./quoteController.js";

const parseOrThrow = <T>(schema: z.ZodSchema<T>, body: unknown): T => {
    const result = schema.safeParse(body);
    if (!result.success) {
        const message = result.error.issues.map(i => i.message).join(" ");
        throw new BadRequestError(message || "Invalid request.");
    }
    return result.data;
};

const submitQuoteIntakeSchema = z.object({
    // Free-form on purpose — the question set varies per company/service
    // type and there is no shared schema to validate every company's
    // wizard against here (see clientModel.ts's quoteIntake field comment).
    serviceType: z.string().trim().min(1, "A service type is required."),
    answers: z.record(z.string(), z.unknown()).default({}),

    firstName: z.string().trim().min(1, "First name is required."),
    lastName: z.string().trim().optional(),
    email: z.string().trim().toLowerCase().email("A valid email is required."),
    phone: z.string().trim().optional(),
    postcode: z.string().trim().optional(),
    address: z.string().trim().optional(),
    marketingConsent: z.boolean().optional(),

    // Client-computed instant estimate, if the wizard reached one. Accepted
    // for backward compatibility with what the wizard already sends, but
    // never stored or trusted — see computeServiceEstimate below, which
    // recomputes the real figure server-side from the published workflow.
    estimate: z
        .object({
            lines: z.array(z.object({ label: z.string(), price: z.number() })).default([]),
            total: z.number().min(0).default(0),
            requiresManualQuote: z.boolean().default(false),
        })
        .optional(),
});

// Exported so quoteWorkflowController.ts's public workflow endpoint
// resolves a company the exact same (bug-fixed) way, rather than a second
// copy of this lookup silently regressing the same status-field gap.
export async function resolvePublicCompany(rawSlug: string | string[] | undefined) {
    const slug = typeof rawSlug === "string" ? rawSlug : undefined;
    if (!slug) throw new NotFoundError("This quote link is invalid.");

    // status is NOT filtered in the query itself — a handful of companies
    // predate that field and have no `status` stored at all, so a raw
    // `{ status: "active" }` filter silently excludes them (Mongoose's
    // schema default only applies once a document is hydrated, not to a
    // query filter — same gap backfillClientLifecycle.ts fixed for
    // Client.lifecycle). Fetched through the model (not .lean()) so the
    // default actually applies, then checked the same way
    // companyStatusMiddleware.ts already does for authenticated routes.
    const company = await Company.findOne({ publicQuoteSlug: slug }).select("_id name logo phone status");
    if (!company || company.status !== "active") throw new NotFoundError("This quote link is invalid.");
    return company;
}

// GET /public/quote-intake/:slug — lets the wizard confirm the link is
// real and show the company's name/logo/phone before the visitor starts.
export const getPublicQuoteIntakeCompany: MiddlewareFn = async (req, res) => {
    const company = await resolvePublicCompany(req.params.slug);
    res.status(StatusCodes.OK).json({
        success: true,
        company: { name: company.name, logo: company.logo?.url ?? null, phone: company.phone ?? null },
    });
};

// Looks up the visitor's chosen service in the company's published
// workflow. Returns null if it can't be resolved (no published workflow,
// or the service type doesn't match/isn't active — e.g. the workflow
// changed between the visitor loading the page and submitting), in which
// case no price is stored rather than trusting whatever the client sent.
async function resolveMatchedService(companyId: unknown, serviceType: string): Promise<QuoteWorkflowServiceType | null> {
    const workflow = await QuoteWorkflow.findOne({ company: companyId }).select("published");
    return workflow?.published?.serviceTypes.find(s => s.key === serviceType && s.active) ?? null;
}

// Best-effort, fire-and-forget — a billing/email hiccup here must never
// turn a successful quote-request submission into a failed one for the
// visitor. Only runs when the matched service opted into
// autoSendQuoteOnSubmit (see quoteWorkflowModel.ts); the manual
// counterpart is leadController.ts's sendLeadQuote. There's no
// authenticated user in this public request, so `createdBy` falls back to
// the company owner — same convention recurringInvoiceGenerator.ts uses
// for its own unattended document creation.
function maybeAutoSendQuote(
    lead: InstanceType<typeof Client>,
    companyId: mongoose.Types.ObjectId,
    service: QuoteWorkflowServiceType | null,
    estimate: ComputedEstimate | null
) {
    if (!service?.autoSendQuoteOnSubmit || !estimate || estimate.requiresManualQuote) return;

    Company.findById(companyId)
        .select("owner")
        .then(async companyDoc => {
            if (!companyDoc?.owner) return;
            const quote = await createQuoteFromLeadIntake({
                companyId,
                createdBy: companyDoc.owner as mongoose.Types.ObjectId,
                lead,
                service,
                estimate,
            });
            await sendQuoteNow(quote, companyId);
        })
        .catch(err => console.error(`Failed to auto-send quote for lead ${lead._id}:`, err));
}

// Best-effort, fire-and-forget — same reasoning as maybeAutoSendQuote
// above. For an existing CLIENT (not a lead), a repeat submission always
// gets a real quote created — unlike the lead path, this doesn't require
// autoSendQuoteOnSubmit to do anything at all, since there's no "first
// intake" being overwritten here for staff to review via quoteIntake; the
// quote itself, visible in the normal Quotes list, is the review surface.
// The toggle still governs whether it's emailed immediately or left as a
// draft for staff to send from there. Deliberately NOT called for
// lifecycle "lost" — reviving a lost opportunity should be a deliberate
// staff action, not an automatic side effect of a public form resubmit.
function createOrSendQuoteForClient(
    client: InstanceType<typeof Client>,
    companyId: mongoose.Types.ObjectId,
    service: QuoteWorkflowServiceType | null,
    estimate: ComputedEstimate | null
) {
    if (!service || !estimate || estimate.requiresManualQuote) return;

    Company.findById(companyId)
        .select("owner")
        .then(async companyDoc => {
            if (!companyDoc?.owner) return;
            const quote = await createQuoteFromLeadIntake({
                companyId,
                createdBy: companyDoc.owner as mongoose.Types.ObjectId,
                lead: client,
                service,
                estimate,
            });
            if (service.autoSendQuoteOnSubmit) {
                await sendQuoteNow(quote, companyId);
            }
        })
        .catch(err => console.error(`Failed to create quote for existing client ${client._id}:`, err));
}

// POST /public/quote-intake/:slug — the wizard's final submit.
export const submitPublicQuoteIntake: MiddlewareFn = async (req, res) => {
    const company = await resolvePublicCompany(req.params.slug);
    const data = parseOrThrow(submitQuoteIntakeSchema, req.body);

    const service = await resolveMatchedService(company._id, data.serviceType);
    const estimate = service ? computeServiceEstimate(service, data.answers) : null;

    const fullName = [data.firstName, data.lastName].filter(Boolean).join(" ");
    const quoteIntake = {
        serviceType: data.serviceType,
        answers: data.answers,
        estimate,
    };

    // Find-or-create — a repeat visitor becomes one lead, not several (the
    // company+billingEmail / company+phone partial indexes on
    // clientModel.ts exist specifically for this). Looked up manually
    // rather than a single atomic upsert so an existing client/lost record
    // for this person is never silently rewritten by a public form.
    const existing = await Client.findOne({
        company: company._id,
        isDeleted: false,
        $or: [{ billingEmail: data.email }, ...(data.phone ? [{ phone: data.phone }] : [])],
    });

    if (existing) {
        if (existing.lifecycle === "lead") {
            existing.quoteIntake = quoteIntake as any;
            if (estimate?.total) existing.estimatedValue = estimate.total;
            await existing.save();
            maybeAutoSendQuote(existing, company._id, service, estimate);
        } else if (existing.lifecycle === "client") {
            // A real customer requesting a further quote (a different
            // service, another job) — goes straight to a Quote rather than
            // touching their Client record. quoteIntake stays untouched: it's
            // meant to be a faithful, never-overwritten record of this
            // person's very first intake, not updated on every resubmit.
            createOrSendQuoteForClient(existing, company._id, service, estimate);
        }
        // Lost leads are deliberately excluded — reviving one should be a
        // deliberate staff action, not an automatic side effect of a public
        // form resubmission.
        res.status(StatusCodes.OK).json({ success: true });
        return;
    }

    try {
        const created = await Client.create({
            company: company._id,
            name: fullName,
            lifecycle: "lead",
            leadSource: "website_quote",
            isAutomated: true,
            createdBy: null,
            billingEmail: data.email,
            phone: data.phone,
            contacts: [{ name: fullName, email: data.email, phone: data.phone, isPrimary: true }],
            address: data.postcode || data.address ? { postcode: data.postcode, line1: data.address } : undefined,
            estimatedValue: estimate?.total ?? 0,
            quoteIntake,
        });
        maybeAutoSendQuote(created, company._id, service, estimate);
    } catch (err: any) {
        // Lost the race with a near-simultaneous duplicate submission —
        // fall back to the update path instead of surfacing a 500.
        if (err?.code !== 11000) throw err;
        const raced = await Client.findOne({
            company: company._id,
            isDeleted: false,
            $or: [{ billingEmail: data.email }, ...(data.phone ? [{ phone: data.phone }] : [])],
        });
        if (raced && raced.lifecycle === "lead") {
            raced.quoteIntake = quoteIntake as any;
            if (estimate?.total) raced.estimatedValue = estimate.total;
            await raced.save();
            maybeAutoSendQuote(raced, company._id, service, estimate);
        }
    }

    res.status(StatusCodes.CREATED).json({ success: true });
};
