import mongoose, { InferSchemaType, Schema } from "mongoose";

// ─────────────────────────────────────────────────────────────
// InvoiceTemplate
// ─────────────────────────────────────────────────────────────
// A visual "theme" invoicePdf.ts's renderer reads to produce an invoice —
// baseLayout is the one structural switch (header style, table style,
// overall skeleton); everything else is orthogonal styling applied
// consistently on top of whichever base is chosen, so there's no untested
// matrix of e.g. "banner header + minimal base" combinations.
//
// System presets (isSystemPreset: true, company: null) are global and
// seeded once; a company's own custom templates set company to their own
// Company id. Flat fields rather than nested design/sections sub-objects —
// matches how Company itself holds a large, ever-growing set of settings
// (see its own "── Time & attendance ──" etc. comment-grouped sections)
// rather than nesting them, and keeps this shape a direct match for
// Invoice.templateSnapshot, which mirrors these same field names flat.
const InvoiceTemplateSchema = new Schema(
  {
    // null for the system presets (global, visible to every company).
    // Set for a company's own custom template.
    company: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      default: null,
      index: true,
    },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null, // presets have no creator
    },

    isSystemPreset: {
      type: Boolean,
      default: false,
      index: true,
    },

    // Stable identifier for the seeded presets only (e.g. "modern-navy",
    // "clean-minimal") — the frontend maps this to a static preview image
    // it already ships, rather than this app storing/serving thumbnails.
    // null for custom templates (their builder has a live preview instead).
    presetKey: {
      type: String,
      default: null,
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    baseLayout: {
      type: String,
      enum: ["modern", "classic", "minimal"],
      required: true,
    },

    accentColor: {
      type: String,
      trim: true,
      default: "#1E3A5F",
    },

    // Constrained to whatever fonts are actually embedded for pdfkit at
    // render time (pdfkit ships Helvetica/Times/Courier by default — any
    // other font needs a .ttf bundled server-side and registered before
    // it's a valid choice here).
    font: {
      type: String,
      enum: ["Helvetica", "Times-Roman", "Inter"],
      default: "Helvetica",
    },

    logoPosition: {
      type: String,
      enum: ["top-left", "top-center", "top-right"],
      default: "top-left",
    },

    showVatBreakdown: { type: Boolean, default: true },
    showPaymentTerms: { type: Boolean, default: true },
    showNotes: { type: Boolean, default: true },

    isDeleted: { type: Boolean, default: false },
  },
  {
    timestamps: true,
  }
);

InvoiceTemplateSchema.index({ company: 1, isDeleted: 1 });

// Only system presets ever set presetKey, and it must be unique among them
// — partial so custom templates (presetKey: null) never collide with each
// other on this index. Lets the seed script upsert by presetKey safely.
InvoiceTemplateSchema.index(
  { presetKey: 1 },
  { unique: true, partialFilterExpression: { isSystemPreset: true } }
);

export type InvoiceTemplate = InferSchemaType<typeof InvoiceTemplateSchema>;

export default mongoose.model("InvoiceTemplate", InvoiceTemplateSchema);
