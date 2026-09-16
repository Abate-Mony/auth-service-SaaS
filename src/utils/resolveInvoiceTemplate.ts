import mongoose from "mongoose";
import InvoiceTemplate from "../models/invoiceTemplateModel.js";
import Company from "../models/company.js";
import { DEFAULT_INVOICE_TEMPLATE, InvoicePdfTemplate } from "./invoicePdf.js";

// Falls back to this system preset when a company has never set a default
// and no explicit template was requested. Must match a presetKey the seed
// script actually creates (seedInvoiceTemplates.ts) — if the seed script
// has never been run in this environment, resolution below still returns a
// usable in-memory default rather than failing a send over it.
const SYSTEM_FALLBACK_PRESET_KEY = "modern-navy";

interface ResolvedTemplate {
  // null when nothing in the DB matched — e.g. the seed script hasn't run
  // yet in this environment. The document's own `template` ref stays unset
  // in that case; `templateSnapshot` (and the render) still get a real
  // value from DEFAULT_INVOICE_TEMPLATE.
  templateId: mongoose.Types.ObjectId | null;
  snapshot: InvoicePdfTemplate & { name: string };
}

function toSnapshot(doc: {
  name: string;
  baseLayout: string;
  accentColor: string;
  font: string;
  logoPosition: string;
  showVatBreakdown: boolean;
  showPaymentTerms: boolean;
  showNotes: boolean;
}): InvoicePdfTemplate & { name: string } {
  return {
    name: doc.name,
    baseLayout: doc.baseLayout as InvoicePdfTemplate["baseLayout"],
    accentColor: doc.accentColor,
    font: doc.font as InvoicePdfTemplate["font"],
    logoPosition: doc.logoPosition as InvoicePdfTemplate["logoPosition"],
    showVatBreakdown: doc.showVatBreakdown,
    showPaymentTerms: doc.showPaymentTerms,
    showNotes: doc.showNotes,
  };
}

// Shared by resolveInvoiceTemplate/resolveQuoteTemplate below — both
// documents draw from the same InvoiceTemplate pool (see quoteModel.ts's
// comment on why), the only difference is which Company field holds the
// per-document-type default.
async function resolveTemplate(
  companyId: mongoose.Types.ObjectId,
  companyDefaultField: "defaultInvoiceTemplate" | "defaultQuoteTemplate",
  explicitTemplateId?: string | null
): Promise<ResolvedTemplate> {
  if (explicitTemplateId) {
    const explicit = await InvoiceTemplate.findOne({
      _id: explicitTemplateId,
      isDeleted: false,
      $or: [{ isSystemPreset: true }, { company: companyId }],
    });
    if (explicit) {
      return { templateId: explicit._id, snapshot: toSnapshot(explicit) };
    }
    // Falls through to the company default rather than throwing — an
    // invalid/deleted/foreign template id shouldn't block sending a
    // document, it just doesn't get to pick the look.
  }

  const company = await Company.findById(companyId).select(companyDefaultField).lean();
  const preferredId = company?.[companyDefaultField];
  if (preferredId) {
    const preferred = await InvoiceTemplate.findOne({ _id: preferredId, isDeleted: false });
    if (preferred) {
      return { templateId: preferred._id, snapshot: toSnapshot(preferred) };
    }
  }

  const fallback = await InvoiceTemplate.findOne({ presetKey: SYSTEM_FALLBACK_PRESET_KEY, isSystemPreset: true });
  if (fallback) {
    return { templateId: fallback._id, snapshot: toSnapshot(fallback) };
  }

  // Seed script hasn't run in this environment — still render something
  // reasonable rather than failing the send.
  return { templateId: null, snapshot: { name: "Default", ...DEFAULT_INVOICE_TEMPLATE } };
}

// Resolution order: an explicit template id (validated — must be a system
// preset or belong to this exact company, never trusted blind) → the
// company's own default → the hardcoded system preset. Used once, at
// invoice-send time, to produce the values that get frozen into
// Invoice.templateSnapshot — see invoiceController.ts's sendInvoiceHandler.
export async function resolveInvoiceTemplate(
  companyId: mongoose.Types.ObjectId,
  explicitTemplateId?: string | null
): Promise<ResolvedTemplate> {
  return resolveTemplate(companyId, "defaultInvoiceTemplate", explicitTemplateId);
}

// Same resolution order, reading Company.defaultQuoteTemplate instead —
// independent from defaultInvoiceTemplate even though both point into the
// same InvoiceTemplate pool.
export async function resolveQuoteTemplate(
  companyId: mongoose.Types.ObjectId,
  explicitTemplateId?: string | null
): Promise<ResolvedTemplate> {
  return resolveTemplate(companyId, "defaultQuoteTemplate", explicitTemplateId);
}
