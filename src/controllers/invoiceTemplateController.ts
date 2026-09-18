import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { getReqUser, MiddlewareFn } from "../interfaces/expresstype.js";
import InvoiceTemplate from "../models/invoiceTemplateModel.js";
import Company from "../models/company.js";
import { generateInvoicePdf, DEFAULT_INVOICE_TEMPLATE } from "../utils/invoicePdf.js";

const TEMPLATE_FIELDS = "name baseLayout accentColor font logoPosition showVatBreakdown showPaymentTerms showNotes isSystemPreset presetKey company";

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

// GET /invoice-templates — every template this company can pick from: the
// system presets (company: null) plus whatever custom ones this company
// has created. Used for both the invoice picker and (later) the quote
// picker — same pool, see quoteModel.ts's comment on why.
export const getInvoiceTemplates: MiddlewareFn = async (req, res) => {
    const companyId = getReqUser(req).company_id;

    const templates = await InvoiceTemplate.find({
        isDeleted: false,
        $or: [{ isSystemPreset: true }, { company: companyId }],
    })
        .select(TEMPLATE_FIELDS)
        .sort({ isSystemPreset: -1, createdAt: 1 })
        .lean();

    res.status(StatusCodes.OK).json({ success: true, templates });
};

// PATCH /companies/invoice-template — sets the company's default. A
// dedicated endpoint rather than folding this into updateCompanySettings:
// unlike every field there, this one needs an async ownership check
// (must be a system preset or belong to this exact company) before it's
// safe to save, not just a synchronous Zod shape check.
export const setDefaultInvoiceTemplate: MiddlewareFn = async (req, res) => {
    const companyId = getReqUser(req).company_id;
    const { templateId } = req.body;

    if (templateId !== null && typeof templateId !== "string") {
        throw new BadRequestError("templateId must be a string id or null.");
    }

    if (templateId === null) {
        const company = await Company.findByIdAndUpdate(
            companyId,
            { $set: { defaultInvoiceTemplate: null } },
            { new: true }
        ).select("defaultInvoiceTemplate");
        res.status(StatusCodes.OK).json({ success: true, defaultInvoiceTemplate: company?.defaultInvoiceTemplate ?? null });
        return;
    }

    // Never trust a bare id from the request — it must be a system preset
    // or actually belong to this company.
    const template = await InvoiceTemplate.findOne({
        _id: templateId,
        isDeleted: false,
        $or: [{ isSystemPreset: true }, { company: companyId }],
    }).select("_id");
    if (!template) throw new NotFoundError("Template not found.");

    const company = await Company.findByIdAndUpdate(
        companyId,
        { $set: { defaultInvoiceTemplate: template._id } },
        { new: true }
    ).select("defaultInvoiceTemplate");

    res.status(StatusCodes.OK).json({ success: true, defaultInvoiceTemplate: company?.defaultInvoiceTemplate ?? null });
};

// ─────────────────────────────────────────────────────────────
// Custom template builder
// ─────────────────────────────────────────────────────────────
// A company's own themed templates — same "knobs" as the 10 system
// presets (baseLayout + accentColor/font/logoPosition/show* toggles), not
// a freeform layout designer; see the original template-picker scoping
// decision (themed knobs, not freeform design). System presets
// (isSystemPreset: true) are immutable — never editable or deletable
// through these routes, only ever seeded.

const hexColor = z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/, "Enter a hex color, e.g. #1E3A5F.");

const templateFieldsSchema = {
    name: z.string().trim().min(1, "Name is required").max(100),
    baseLayout: z.enum(["modern", "classic", "minimal"]),
    accentColor: hexColor,
    font: z.enum(["Helvetica", "Times-Roman", "Inter"]),
    logoPosition: z.enum(["top-left", "top-center", "top-right"]),
    showVatBreakdown: z.boolean(),
    showPaymentTerms: z.boolean(),
    showNotes: z.boolean(),
};

const createTemplateSchema = z
    .object({
        name: templateFieldsSchema.name,
        baseLayout: templateFieldsSchema.baseLayout.default("modern"),
        accentColor: templateFieldsSchema.accentColor.default("#1E3A5F"),
        font: templateFieldsSchema.font.default("Helvetica"),
        logoPosition: templateFieldsSchema.logoPosition.default("top-left"),
        showVatBreakdown: templateFieldsSchema.showVatBreakdown.default(true),
        showPaymentTerms: templateFieldsSchema.showPaymentTerms.default(true),
        showNotes: templateFieldsSchema.showNotes.default(true),
    })
    .strict();

const updateTemplateSchema = z.object(templateFieldsSchema).partial().strict();

// POST /invoice-templates — admin-only (route-gated). Creates a
// company-owned template; never touches the system preset pool.
export const createInvoiceTemplate: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(createTemplateSchema, req.body);
    const companyId = getReqUser(req).company_id;

    const template = await InvoiceTemplate.create({
        ...data,
        company: companyId,
        createdBy: req.user.user_id,
        isSystemPreset: false,
        presetKey: null,
    });

    res.status(StatusCodes.CREATED).json({ success: true, template });
};

// PATCH /invoice-templates/:id — admin-only. Ownership re-checked here,
// not trusted from a prior GET — a template id alone proves nothing.
export const updateInvoiceTemplate: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(updateTemplateSchema, req.body);
    if (Object.keys(data).length === 0) throw new BadRequestError("No valid fields provided.");

    const companyId = getReqUser(req).company_id;
    const template = await InvoiceTemplate.findOne({ _id: req.params.id, company: companyId, isSystemPreset: false, isDeleted: false });
    if (!template) throw new NotFoundError("Template not found.");

    Object.assign(template, data);
    await template.save();

    res.status(StatusCodes.OK).json({ success: true, template });
};

// DELETE /invoice-templates/:id — admin-only. Soft delete — a company that
// had this set as its default (or an already-sent invoice/quote whose
// templateSnapshot was frozen from it) is safe either way: resolveTemplate
// falls back to the system default the moment isDeleted excludes it from
// lookup, and a frozen snapshot never re-reads the live template at all.
export const deleteInvoiceTemplate: MiddlewareFn = async (req, res) => {
    const companyId = getReqUser(req).company_id;
    const template = await InvoiceTemplate.findOne({ _id: req.params.id, company: companyId, isSystemPreset: false, isDeleted: false });
    if (!template) throw new NotFoundError("Template not found.");

    template.isDeleted = true;
    await template.save();

    res.status(StatusCodes.OK).json({ success: true, msg: "Template deleted." });
};

const previewTemplateSchema = z.object(templateFieldsSchema).partial().strict();

// POST /invoice-templates/preview — admin-only. Renders a real sample PDF
// from in-progress (possibly unsaved) knob values, using canned sample
// data — the builder's live preview, not tied to any real invoice/quote.
export const previewInvoiceTemplate: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(previewTemplateSchema, req.body);

    const template = {
        baseLayout: data.baseLayout ?? DEFAULT_INVOICE_TEMPLATE.baseLayout,
        accentColor: data.accentColor ?? DEFAULT_INVOICE_TEMPLATE.accentColor,
        font: data.font ?? DEFAULT_INVOICE_TEMPLATE.font,
        logoPosition: data.logoPosition ?? DEFAULT_INVOICE_TEMPLATE.logoPosition,
        showVatBreakdown: data.showVatBreakdown ?? DEFAULT_INVOICE_TEMPLATE.showVatBreakdown,
        showPaymentTerms: data.showPaymentTerms ?? DEFAULT_INVOICE_TEMPLATE.showPaymentTerms,
        showNotes: data.showNotes ?? DEFAULT_INVOICE_TEMPLATE.showNotes,
    };

    const doc = generateInvoicePdf({
        invoiceNumber: "INV-0001",
        companyName: "Sample Company Ltd",
        companyPhone: "020 7946 0958",
        clientName: "Northstar Facilities Ltd",
        clientAddress: "14 Riverside Way, Bristol, BS1 4ST",
        clientVatNumber: "GB123456789",
        issueDate: new Date(),
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        lineItems: [
            { description: "Weekly office cleaning", type: "hourly", hours: 12, rate: 18.5, amount: 222, date: new Date(), startTime: "08:00", endTime: "10:00", location: "Bristol Distribution Centre", workerName: "Sam Carter" },
            { description: "Cleaning materials", type: "fixed", hours: 0, rate: 0, amount: 35 },
        ],
        subtotal: 257,
        vatRate: 20,
        vatAmount: 51.4,
        total: 308.4,
        currency: "GBP",
        notes: "Thank you for your business.",
        template: template as any,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="template-preview.pdf"`);
    doc.pipe(res);
    doc.end();
};
