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
import User from "../models/userModel.js";
import QuoteWorkflow, { type QuoteWorkflowServiceType } from "../models/quoteWorkflowModel.js";
import { computeServiceEstimate, type ComputedEstimate } from "../services/quoteWorkflow/estimatePrice.js";
import { createQuoteFromLeadIntake } from "../services/quote/createQuoteFromLeadIntake.js";
import { sendQuoteNow } from "./quoteController.js";
import { notifyUser } from "../utils/notifyUser.js";
import { shouldNotify } from "../services/notificationPreferenceService.js";
import { sendQuoteRequestSubmittedEmail } from "../utils/mailTemplates.js";
import { sendPushToUser } from "../utils/webPush.js";
import { sendExpoPushToUser } from "../utils/expoPush.js";
import { MANAGEMENT_ROLES } from "../utils/roles.js";

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

// Best-effort, fire-and-forget — same reasoning as the other helpers below:
// a notification hiccup must never fail the visitor's own submission.
// Covers every path through submitPublicQuoteIntake (new lead, a lead
// resubmitting, or an existing client requesting a further quote) —
// previously none of them told staff a request had come in at all, short
// of someone happening to open the Leads or Quotes page. Each of the
// in-app/email/push channels is gated per recipient by their own
// notification preference (shouldNotify) — never sent unconditionally,
// same pattern as maybeCompleteJob.ts.
function notifyQuoteRequestSubmitted(
    companyId: mongoose.Types.ObjectId,
    personId: mongoose.Types.ObjectId,
    personName: string,
    serviceLabel: string,
    estimateTotal: number | null,
    link: string
) {
    Promise.all([
        User.find({ company: companyId, role: { $in: MANAGEMENT_ROLES }, isActive: true }).select("_id email"),
        Company.findById(companyId).select("currency"),
    ])
        .then(([staff, companyDoc]) => {
            const currency = companyDoc?.currency ?? "GBP";
            return Promise.all(
                staff.map(async u => {
                    const userId = u._id.toString();
                    const [canEmail, canPush] = await Promise.all([
                        shouldNotify(userId, "quote_request_submitted", "email"),
                        shouldNotify(userId, "quote_request_submitted", "push"),
                    ]);

                    await Promise.all([
                        notifyUser({
                            userId,
                            companyId,
                            event: "quote_request_submitted",
                            title: "New quote request",
                            body: `${personName} requested a quote for ${serviceLabel}`,
                            link,
                        }),
                        canEmail
                            ? sendQuoteRequestSubmittedEmail({
                                staffEmail: u.email,
                                personName,
                                serviceLabel,
                                estimateTotal,
                                currency,
                                link,
                                company: companyId,
                            })
                            : Promise.resolve(),
                        canPush
                            ? sendPushToUser(userId, {
                                title: "New quote request",
                                body: `${personName} requested a quote for ${serviceLabel}`,
                                tag: `quote-request-${personId}`,
                                url: link,
                            })
                            : Promise.resolve(),
                        canPush
                            ? sendExpoPushToUser(userId, {
                                title: "New quote request",
                                body: `${personName} requested a quote for ${serviceLabel}`,
                                tag: `quote-request-${personId}`,
                                url: link,
                            })
                            : Promise.resolve(),
                    ]);
                })
            );
        })
        .catch(err => console.error(`Failed to notify staff of quote request for ${personId}:`, err));
}

// Best-effort, fire-and-forget — a billing/email hiccup here must never
// turn a successful quote-request submission into a failed one for the
// visitor. Called for EVERY wizard submission — new lead, a lead or
// client resubmitting for a different service, whatever — so a second
// request never overwrites or loses the first the way the old single
// Client.quoteIntake snapshot used to. Each submission becomes its own
// draft Quote, exactly how a repeat client request already worked; leads
// now get the same treatment. The service's autoSendQuoteOnSubmit toggle
// only governs whether it's emailed immediately or left as a draft for
// staff to send from the Quotes page (POST /quotes/:id/send) — it never
// skips creating the quote itself. Deliberately NOT called for lifecycle
// "lost" — reviving a lost opportunity should be a deliberate staff
// action, not an automatic side effect of a public form resubmit. There's
// no authenticated user in this public request, so `createdBy` falls back
// to the company owner — same convention recurringInvoiceGenerator.ts
// uses for its own unattended document creation.
function createOrSendQuote(
    person: InstanceType<typeof Client>,
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
                lead: person,
                service,
                estimate,
            });
            if (service.autoSendQuoteOnSubmit) {
                await sendQuoteNow(quote, companyId);
            }
        })
        .catch(err => console.error(`Failed to create quote for ${person._id}:`, err));
}

// POST /public/quote-intake/:slug — the wizard's final submit.
export const submitPublicQuoteIntake: MiddlewareFn = async (req, res) => {
    const company = await resolvePublicCompany(req.params.slug);
    const data = parseOrThrow(submitQuoteIntakeSchema, req.body);

    const service = await resolveMatchedService(company._id, data.serviceType);
    const estimate = service ? computeServiceEstimate(service, data.answers) : null;

    const fullName = [data.firstName, data.lastName].filter(Boolean).join(" ");
    const serviceLabel = service?.label ?? data.serviceType;
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
            // quoteIntake is a faithful record of this lead's very FIRST
            // intake only — never overwritten by a later resubmit (a second
            // request for a different service used to silently replace it,
            // losing the first one). Each submission, first or repeat,
            // still gets its own draft Quote via createOrSendQuote below, so
            // nothing about a later request is actually lost.
            if (!existing.quoteIntake) {
                existing.quoteIntake = quoteIntake as any;
            }
            if (estimate?.total) existing.estimatedValue = estimate.total;
            await existing.save();
            createOrSendQuote(existing, company._id, service, estimate);
            notifyQuoteRequestSubmitted(company._id, existing._id, existing.name, serviceLabel, estimate?.total ?? null, `/leads/${existing._id}`);
        } else if (existing.lifecycle === "client") {
            // A real customer requesting a further quote (a different
            // service, another job) — goes straight to a Quote rather than
            // touching their Client record. quoteIntake stays untouched: it's
            // meant to be a faithful, never-overwritten record of this
            // person's very first intake, not updated on every resubmit.
            createOrSendQuote(existing, company._id, service, estimate);
            notifyQuoteRequestSubmitted(company._id, existing._id, existing.name, serviceLabel, estimate?.total ?? null, `/clients/${existing._id}`);
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
        createOrSendQuote(created, company._id, service, estimate);
        notifyQuoteRequestSubmitted(company._id, created._id, created.name, serviceLabel, estimate?.total ?? null, `/leads/${created._id}`);
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
            if (!raced.quoteIntake) {
                raced.quoteIntake = quoteIntake as any;
            }
            if (estimate?.total) raced.estimatedValue = estimate.total;
            await raced.save();
            createOrSendQuote(raced, company._id, service, estimate);
            notifyQuoteRequestSubmitted(company._id, raced._id, raced.name, serviceLabel, estimate?.total ?? null, `/leads/${raced._id}`);
        }
    }

    res.status(StatusCodes.CREATED).json({ success: true });
};
