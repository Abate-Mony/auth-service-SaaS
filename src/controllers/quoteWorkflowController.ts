// Admin-side editing (authenticated, company-scoped) and the public,
// read-only published view of a company's quote-request wizard. See
// quoteWorkflowModel.ts for the draft/published split and why pricing is
// additive-only.
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import mongoose from "mongoose";
import { BadRequestError } from "../errors/customErrors.js";
import { getReqUser, MiddlewareFn } from "../interfaces/expresstype.js";
import QuoteWorkflow from "../models/quoteWorkflowModel.js";
import { buildDefaultWorkflowServiceTypes } from "../services/quoteWorkflow/defaultWorkflowSeed.js";
import { resolvePublicCompany } from "./publicQuoteIntakeController.js";

const parseOrThrow = <T>(schema: z.ZodSchema<T>, body: unknown): T => {
    const result = schema.safeParse(body);
    if (!result.success) {
        const message = result.error.issues.map(i => `${i.path.join(".") || "value"}: ${i.message}`).join("; ");
        throw new BadRequestError(message || "Invalid request.");
    }
    return result.data;
};

// ── Validation ──────────────────────────────────────────────────────────

const stepOptionSchema = z.object({
    label: z.string().trim().min(1, "Option label is required."),
    value: z.string().trim().min(1, "Option value is required."),
    priceDelta: z.number().default(0),
    order: z.number().int().min(0),
});

const numberConfigSchema = z.object({
    min: z.number().default(1),
    max: z.number().default(10),
    step: z.number().default(1),
    pricePerUnit: z.number().default(0),
});

const stepTypeEnum = z.enum(["choice", "multiselect", "number", "text", "textarea", "date", "contact"]);

const stepDefinitionSchema = z
    .object({
        id: z.string().trim().min(1, "Step id is required."),
        type: stepTypeEnum,
        label: z.string().trim().min(1, "Step label is required."),
        subtitle: z.string().trim().default(""),
        placeholder: z.string().trim().default(""),
        helpText: z.string().trim().default(""),
        required: z.boolean().default(true),
        order: z.number().int().min(0),
        active: z.boolean().default(true),
        options: z.array(stepOptionSchema).optional(),
        numberConfig: numberConfigSchema.optional(),
    })
    .superRefine((step, ctx) => {
        if ((step.type === "choice" || step.type === "multiselect") && (!step.options || step.options.length === 0)) {
            ctx.addIssue({ code: "custom", message: `Step "${step.id}" (${step.type}) needs at least one option.` });
        }
        if (step.type === "number" && !step.numberConfig) {
            ctx.addIssue({ code: "custom", message: `Step "${step.id}" (number) needs numberConfig.` });
        }
        if (step.options) {
            const values = step.options.map(o => o.value);
            if (new Set(values).size !== values.length) {
                ctx.addIssue({ code: "custom", message: `Step "${step.id}" has duplicate option values.` });
            }
        }
    });

const serviceTypeSchema = z
    .object({
        key: z.string().trim().min(1, "Service type key is required."),
        label: z.string().trim().min(1, "Service type label is required."),
        description: z.string().trim().default(""),
        icon: z.string().trim().default(""),
        order: z.number().int().min(0),
        active: z.boolean().default(true),
        basePrice: z.number().min(0).default(0),
        requiresManualQuote: z.boolean().default(false),
        questionsPerPage: z.number().int().min(1).default(1),
        depositPercentage: z.number().min(0).max(100).default(0),
        autoSendQuoteOnSubmit: z.boolean().default(false),
        steps: z.array(stepDefinitionSchema),
    })
    .superRefine((svc, ctx) => {
        const ids = svc.steps.map(s => s.id);
        if (new Set(ids).size !== ids.length) {
            ctx.addIssue({ code: "custom", message: `Service type "${svc.key}" has duplicate step ids.` });
        }
    });

const draftSchema = z
    .object({
        serviceTypes: z.array(serviceTypeSchema),
    })
    .superRefine((draft, ctx) => {
        const keys = draft.serviceTypes.map(s => s.key);
        if (new Set(keys).size !== keys.length) {
            ctx.addIssue({ code: "custom", message: "Duplicate service type keys." });
        }
    });

// ── Shared ──────────────────────────────────────────────────────────────

async function findOrCreateWorkflow(companyId: string | mongoose.Types.ObjectId) {
    let workflow = await QuoteWorkflow.findOne({ company: companyId });
    if (!workflow) {
        // A brand-new company (or one that's never opened Quote Workflow
        // settings before) starts from the seed template — see
        // defaultWorkflowSeed.ts for why that's deliberately small.
        workflow = await QuoteWorkflow.create({
            company: companyId,
            draft: { serviceTypes: buildDefaultWorkflowServiceTypes() },
        });
    }
    return workflow;
}

// ── Admin (authenticated) ──────────────────────────────────────────────

export const getQuoteWorkflow: MiddlewareFn = async (req, res) => {
    const workflow = await findOrCreateWorkflow(getReqUser(req).company_id);
    res.status(StatusCodes.OK).json({
        success: true,
        draft: workflow.draft,
        published: workflow.published,
        publishedAt: workflow.publishedAt,
    });
};

export const saveQuoteWorkflowDraft: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(draftSchema, req.body);
    const workflow = await findOrCreateWorkflow(getReqUser(req).company_id);
    // Whole-document replace, not a per-field patch — matches how the
    // Settings builder will actually save (local edits, then "Save
    // draft"), and sidesteps partial-update race conditions on a
    // deeply-nested structure like this.
    workflow.draft = data as typeof workflow.draft;
    await workflow.save();
    res.status(StatusCodes.OK).json({ success: true, draft: workflow.draft });
};

export const publishQuoteWorkflow: MiddlewareFn = async (req, res) => {
    const workflow = await findOrCreateWorkflow(getReqUser(req).company_id);
    if (!workflow.draft || workflow.draft.serviceTypes.length === 0) {
        throw new BadRequestError("Add at least one service type before publishing.");
    }
    workflow.published = workflow.draft;
    workflow.publishedAt = new Date();
    await workflow.save();
    res.status(StatusCodes.OK).json({
        success: true,
        published: workflow.published,
        publishedAt: workflow.publishedAt,
    });
};

// ── Public (unauthenticated) ───────────────────────────────────────────

// GET /public/quote-intake/:slug/workflow — only ever reads `published`,
// never `draft`. A company that's never published gets an empty list
// back, not a 404 — the link itself is still valid, there's just nothing
// to show yet.
export const getPublicQuoteWorkflow: MiddlewareFn = async (req, res) => {
    const company = await resolvePublicCompany(req.params.slug);
    const workflow = await QuoteWorkflow.findOne({ company: company._id }).select("published").lean();

    if (!workflow?.published) {
        res.status(StatusCodes.OK).json({ success: true, serviceTypes: [] });
        return;
    }

    const serviceTypes = workflow.published.serviceTypes
        .filter(st => st.active)
        .sort((a, b) => a.order - b.order)
        .map(st => ({
            ...st,
            steps: st.steps.filter(s => s.active).sort((a, b) => a.order - b.order),
        }));

    res.status(StatusCodes.OK).json({ success: true, serviceTypes });
};
