import mongoose, { InferSchemaType, Schema } from "mongoose";

// A company's editable public quote-request wizard — what
// publicQuoteIntakeController.ts's wizard renders for a visitor, and what
// Settings → Quote Workflow (work.wk, not yet built) edits. Replaces the
// hand-written per-industry config (quote.xeniapure.com's registry.tsx/
// flow.ts/schemas.ts) with data a non-developer admin can add to, edit, or
// delete from — starting from a seeded template, never from scratch.
//
// draft/published split is deliberate: every edit here would otherwise
// change the live public form instantly, mid-visitor-session. `draft` is
// what the admin edits; `published` is the only thing the public wizard
// ever reads, and only changes on an explicit publish action.
const StepOptionSchema = new Schema(
  {
    label: { type: String, required: true, trim: true },
    // Stable key for this option — what actually gets stored in a
    // submitted answer and matched against branching/pricing. Not
    // regenerated on label edits, so renaming an option's display text
    // never silently breaks a previously-stored answer's meaning.
    value: { type: String, required: true, trim: true },
    // Flat £ addition to the instant estimate when this option is
    // selected — summed across every selected option on the step. See
    // quoteWorkflowModel.ts's module comment for why this is additive-only
    // rather than formula-based.
    priceDelta: { type: Number, default: 0 },
    order: { type: Number, required: true },
  },
  { _id: false }
);

const NumberConfigSchema = new Schema(
  {
    min: { type: Number, default: 1 },
    max: { type: Number, default: 10 },
    step: { type: Number, default: 1 },
    // £ added to the estimate per unit of the number picked — e.g.
    // "bedrooms" at pricePerUnit: 20 contributes 20×N to the total.
    pricePerUnit: { type: Number, default: 0 },
  },
  { _id: false }
);

const STEP_TYPES = ["choice", "multiselect", "number", "text", "textarea", "date", "contact"] as const;

const StepDefinitionSchema = new Schema(
  {
    // Stable slug — also the field name the visitor's answer is stored
    // under (see Client.quoteIntake.answers). Never regenerated on label
    // edits, for the same reason as StepOptionSchema.value above.
    id: { type: String, required: true, trim: true },
    type: { type: String, enum: STEP_TYPES, required: true },
    label: { type: String, required: true, trim: true },
    subtitle: { type: String, trim: true, default: "" },
    placeholder: { type: String, trim: true, default: "" },
    helpText: { type: String, trim: true, default: "" },
    required: { type: Boolean, default: true },
    order: { type: Number, required: true },
    // Hides the step from the live (published) wizard without deleting
    // it — an admin can turn a question off temporarily and get its
    // content/options/pricing back later, rather than losing it.
    active: { type: Boolean, default: true },

    // Only meaningful for type: "choice" | "multiselect".
    options: { type: [StepOptionSchema], default: undefined },

    // Only meaningful for type: "number".
    numberConfig: { type: NumberConfigSchema, default: undefined },
  },
  { _id: false }
);

const ServiceTypeSchema = new Schema(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: "" },
    icon: { type: String, trim: true, default: "" },
    order: { type: Number, required: true },
    active: { type: Boolean, default: true },

    // Starting price before any step option's priceDelta is added.
    // estimatedPrice = basePrice + sum(selectedOption.priceDelta) —
    // always recomputed server-side at submit time, never trusted from
    // the client (see publicQuoteIntakeController.ts).
    basePrice: { type: Number, default: 0, min: 0 },

    // When true, this service type never gets an instant estimate — the
    // wizard always routes straight to the "we'll review and get back to
    // you" screen regardless of answers (matches today's commercial/
    // facilities/after-build/other behaviour, which never computed a
    // price either).
    requiresManualQuote: { type: Boolean, default: false },

    // How many of this service's questions the public wizard shows per
    // page — 1 (default) matches the original one-question-per-screen
    // wizard; a higher number groups that many consecutive active,
    // non-contact steps (by order) onto one page so a long form takes
    // fewer screens to get through. The contact step is always its own
    // final page regardless of this value. Purely a display grouping —
    // doesn't change step order, validation, or pricing.
    questionsPerPage: { type: Number, default: 1, min: 1 },

    // What % of the instant estimate to collect as a deposit when the
    // client accepts the quote this service type produces — 0 (default)
    // means no deposit invoice gets created on accept. Only meaningful
    // alongside an instant price, so irrelevant when requiresManualQuote
    // is true. See quoteController.ts's respondToPublicQuote.
    depositPercentage: { type: Number, default: 0, min: 0, max: 100 },

    // When true, a submission for this service skips the manual "Send
    // quote" review step in the Leads CRM and emails the quote
    // immediately — see publicQuoteIntakeController.ts's
    // submitPublicQuoteIntake. Default false: a company opts into
    // trusting its own configured pricing enough to skip the review
    // click, rather than this being on by default.
    autoSendQuoteOnSubmit: { type: Boolean, default: false },

    steps: { type: [StepDefinitionSchema], default: [] },
  },
  { _id: false }
);

const WorkflowStateSchema = new Schema(
  {
    serviceTypes: { type: [ServiceTypeSchema], default: [] },
  },
  { _id: false }
);

const QuoteWorkflowSchema = new Schema(
  {
    company: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      unique: true,
      index: true,
    },

    draft: { type: WorkflowStateSchema, default: () => ({ serviceTypes: [] }) },

    // null until the company publishes for the first time — the public
    // workflow endpoint must treat that as "no live form yet", not fall
    // back to draft content a visitor was never meant to see.
    published: { type: WorkflowStateSchema, default: null },
    publishedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export type QuoteWorkflow = InferSchemaType<typeof QuoteWorkflowSchema>;

// Plain-data shapes for building/validating workflow content (the seed
// template, Zod-parsed request bodies) — deliberately NOT InferSchemaType
// of the subdocument schemas above, which produces Mongoose's hydrated
// Subdocument type (with $isSingleNested, parent(), etc.), not something
// you can hand-construct as a plain object literal.
export interface QuoteWorkflowOption {
  label: string;
  value: string;
  priceDelta: number;
  order: number;
}

export interface QuoteWorkflowNumberConfig {
  min: number;
  max: number;
  step: number;
  pricePerUnit: number;
}

export type QuoteWorkflowStepType = (typeof STEP_TYPES)[number];

export interface QuoteWorkflowStep {
  id: string;
  type: QuoteWorkflowStepType;
  label: string;
  subtitle?: string;
  placeholder?: string;
  helpText?: string;
  required: boolean;
  order: number;
  active: boolean;
  options?: QuoteWorkflowOption[];
  numberConfig?: QuoteWorkflowNumberConfig;
}

export interface QuoteWorkflowServiceType {
  key: string;
  label: string;
  description?: string;
  icon?: string;
  order: number;
  active: boolean;
  basePrice: number;
  requiresManualQuote: boolean;
  questionsPerPage: number;
  depositPercentage: number;
  autoSendQuoteOnSubmit: boolean;
  steps: QuoteWorkflowStep[];
}

export default mongoose.model("QuoteWorkflow", QuoteWorkflowSchema);
