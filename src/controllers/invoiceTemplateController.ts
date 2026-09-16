import { StatusCodes } from "http-status-codes";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { getReqUser, MiddlewareFn } from "../interfaces/expresstype.js";
import InvoiceTemplate from "../models/invoiceTemplateModel.js";
import Company from "../models/company.js";

const TEMPLATE_FIELDS = "name baseLayout accentColor font logoPosition showVatBreakdown showPaymentTerms showNotes isSystemPreset presetKey company";

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
