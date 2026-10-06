// Public, unauthenticated endpoints behind a company's quote-request link
// (quotes.onclockly.com/<publicQuoteSlug> — see utils/publicSlug.ts and
// Company.publicQuoteSlug). A visitor filling in the wizard becomes a Lead
// (Client with lifecycle: "lead"), the same model/pipeline the in-app
// Leads CRM already runs on — see leadController.ts.
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import Company from "../models/company.js";
import Client from "../models/clientModel.js";

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

    // Client-computed instant estimate, if the wizard reached one —
    // informational only, never trusted as a real price. Staff still
    // builds the actual Quote through the normal authenticated flow.
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

// POST /public/quote-intake/:slug — the wizard's final submit.
export const submitPublicQuoteIntake: MiddlewareFn = async (req, res) => {
    const company = await resolvePublicCompany(req.params.slug);
    const data = parseOrThrow(submitQuoteIntakeSchema, req.body);

    const fullName = [data.firstName, data.lastName].filter(Boolean).join(" ");
    const quoteIntake = {
        serviceType: data.serviceType,
        answers: data.answers,
        estimate: data.estimate ?? null,
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
            if (data.estimate?.total) existing.estimatedValue = data.estimate.total;
            await existing.save();
        }
        // Already a client or lost — a real relationship already exists
        // with this company, so the form submission is acknowledged but
        // doesn't touch their record. Staff can still see it via quoteIntake
        // if this ever needs surfacing differently; out of scope for now.
        res.status(StatusCodes.OK).json({ success: true });
        return;
    }

    try {
        await Client.create({
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
            estimatedValue: data.estimate?.total ?? 0,
            quoteIntake,
        });
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
            if (data.estimate?.total) raced.estimatedValue = data.estimate.total;
            await raced.save();
        }
    }

    res.status(StatusCodes.CREATED).json({ success: true });
};
