import mongoose, { InferSchemaType, Schema } from "mongoose";

const ClientSchema = new Schema(
  {
    // ── Scoping ───────────────────────────────────────────────────────
    company: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },

    // ── Identity ──────────────────────────────────────────────────────
    name: {
      type: String,
      required: [true, "Client name is required"],
      trim: true,
      maxlength: 150,
    },

    contacts: [
      {
        name: { type: String, trim: true },
        role: { type: String, trim: true },
        email: { type: String, trim: true, lowercase: true },
        phone: { type: String, trim: true },
        isPrimary: { type: Boolean, default: false },
        _id: false,
      },
    ],

    phone: { type: String, trim: true },

    // ── Billing ───────────────────────────────────────────────────────
    billingEmail: { type: String, trim: true, lowercase: true },
    vatNumber: { type: String, trim: true, uppercase: true },

    address: {
      line1: { type: String, trim: true },
      line2: { type: String, trim: true },
      city: { type: String, trim: true },
      county: { type: String, trim: true },
      postcode: { type: String, trim: true, uppercase: true },
      country: { type: String, trim: true, default: "United Kingdom" },
    },

    defaultChargeType: {
      type: String,
      enum: ["hourly", "fixed"],
      default: "hourly",
    },

    defaultChargeRate: {
      type: Number,
      default: 0,
      min: 0,
    },

    paymentTermsDays: {
      type: Number,
      default: 30,
      min: 0,
    },

    // ── Billing policy ────────────────────────────────────────────────
    billingFrequency: {
      type: String,
      enum: ["per_job", "weekly", "fortnightly", "monthly", "manual"],
      default: "monthly",
    },

    billingDayOfWeek: {
      type: Number,
      min: 0,
      max: 6,
    },

    billingDayOfMonth: {
      type: Number,
      min: 1,
      max: 31,
    },

    // ── Lifecycle ─────────────────────────────────────────────────────
    // What this record currently represents commercially. Deliberately
    // separate from `status` below: lifecycle is "who are they to us",
    // status is "are we currently working with them".
    lifecycle: {
      type: String,
      enum: ["lead", "client", "lost"],
      default: "lead",
      index: true,
    },

    // Only relevant while lifecycle === "lead". Cleared on conversion.
    leadStage: {
      type: String,
      enum: ["new", "contacted", "call_booked", "quote_sent", "negotiating"],
      default: null,
      index: true,
    },

    leadSource: {
      type: String,
      enum: [
        "website_quote",
        "phone",
        "email",
        "referral",
        "walk_in",
        "other",
      ],
    },

    nextFollowUpAt: {
      type: Date,
      default: null,
    },

    lastContactedAt: {
      type: Date,
      default: null,
    },

    assignedTo: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // Manager's rough guess at deal size — drives the pipeline-value figure
    // on the leads summary. Never touched by conversion; a client keeps
    // whatever its last estimate was, for comparison against actual billing.
    estimatedValue: {
      type: Number,
      default: 0,
      min: 0,
    },

    convertedAt: {
      type: Date,
      default: null,
    },

    lostAt: {
      type: Date,
      default: null,
    },

    lostReason: {
      type: String,
      trim: true,
      default: "",
      maxlength: 500,
    },

    // Append-only trail of lifecycle moves. Exists so that converting a
    // previously-lost lead can safely wipe lostAt/lostReason (which drive
    // live queries) without destroying the fact that they once went cold
    // and why — that history is the useful part when reviewing where
    // leads actually come from.
    lifecycleHistory: [
      {
        from: { type: String, enum: ["lead", "client", "lost"] },
        to: { type: String, enum: ["lead", "client", "lost"] },
        reason: { type: String, trim: true, maxlength: 500, default: "" },
        at: { type: Date, default: Date.now },
        by: { type: Schema.Types.ObjectId, ref: "User", default: null },
        _id: false,
      },
    ],

    // ── State ─────────────────────────────────────────────────────────
    // Operational state — separate from lifecycle.
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
      index: true,
    },

    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },

    // ── Provenance ────────────────────────────────────────────────────
    // True when the record was created by the public quote form rather
    // than by a person inside the app. Paired with createdBy being
    // nullable: an automated lead has no author, and inventing a system
    // user just puts a fake name in every "created by" filter.
    isAutomated: {
      type: Boolean,
      default: false,
    },

    // ── Misc ──────────────────────────────────────────────────────────
    notes: {
      type: String,
      trim: true,
      default: "",
      maxlength: 2000,
    },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

// ── Indexes ───────────────────────────────────────────────────────────

// Existing client list query
ClientSchema.index({
  company: 1,
  status: 1,
  isDeleted: 1,
});

// Leads page
ClientSchema.index({
  company: 1,
  lifecycle: 1,
  status: 1,
  nextFollowUpAt: 1,
});

// Allow duplicate lead names, but not duplicate live client names.
// NOTE: converting a lead whose name matches an existing client throws
// E11000 — the convert handler must catch code 11000 and offer
// merge-or-rename rather than returning a 500.
ClientSchema.index(
  { company: 1, name: 1 },
  {
    unique: true,
    partialFilterExpression: {
      isDeleted: false,
      lifecycle: "client",
    },
  }
);

// Find-or-create keys for the public quote form, so a repeat visitor
// doesn't become a second lead.
ClientSchema.index(
  { company: 1, billingEmail: 1 },
  {
    partialFilterExpression: {
      billingEmail: { $type: "string" },
    },
  }
);

ClientSchema.index(
  { company: 1, phone: 1 },
  {
    partialFilterExpression: {
      phone: { $type: "string" },
    },
  }
);

// ── Validation / lifecycle rules ──────────────────────────────────────

ClientSchema.pre("validate", async function () {
  const primaries = (this.contacts ?? []).filter(
    (contact) => contact.isPrimary
  );

  if (primaries.length > 1) {
    throw new Error("Only one contact can be marked as primary");
  }

  if (!primaries.length && this.contacts?.length) {
    this.contacts[0].isPrimary = true;
  }

  // Record the move before the branches below rewrite the fields that
  // evidence it. isModified is false on a new document, so this only
  // fires on a genuine transition.
  if (!this.isNew && this.isModified("lifecycle")) {
    this.lifecycleHistory.push({
      from: (this as any).$locals?.previousLifecycle ?? undefined,
      to: this.lifecycle,
      reason: this.lifecycle === "lost" ? this.lostReason : "",
      at: new Date(),
      by: (this as any).$locals?.actorId ?? null,
    });
  }

  // Converted from lead to client.
  if (this.lifecycle === "client") {
    if (!this.convertedAt) {
      this.convertedAt = new Date();
    }

    this.leadStage = null;
    this.nextFollowUpAt = null;

    // A won lead is active again regardless of how it got here.
    this.status = "active";

    // Live query fields are cleared; the history entry above keeps the
    // record that they were once lost.
    this.lostAt = null;
    this.lostReason = "";
  }

  // Lead lost.
  if (this.lifecycle === "lost") {
    if (!this.lostAt) {
      this.lostAt = new Date();
    }

    this.status = "inactive";
  }

  // Normal active lead — including a lost lead being reopened, which must
  // come back out of `inactive` or it is invisible to the leads list and
  // followUpOverdue silently returns false forever.
  if (this.lifecycle === "lead") {
    if (!this.leadStage) {
      this.leadStage = "new";
    }

    if (this.lostAt || this.status === "inactive") {
      this.status = "active";
      this.lostAt = null;
      this.lostReason = "";
    }
  }
});

// Capture the stored lifecycle before an edit overwrites it, so the
// history entry above can record what it moved *from*.
ClientSchema.post("init", function (doc: any) {
  doc.$locals.previousLifecycle = doc.lifecycle;
});

// ── Virtuals ──────────────────────────────────────────────────────────

ClientSchema.virtual("primaryContact").get(function (this: any) {
  return (
    (this.contacts ?? []).find((c: any) => c.isPrimary) ??
    this.contacts?.[0] ??
    null
  );
});

ClientSchema.virtual("formattedAddress").get(function (this: any) {
  const a = this.address ?? {};

  return [a.line1, a.line2, a.city, a.county, a.postcode, a.country]
    .filter(Boolean)
    .join(", ");
});

ClientSchema.virtual("isLead").get(function (this: any) {
  return this.lifecycle === "lead";
});

ClientSchema.virtual("followUpOverdue").get(function (this: any) {
  if (
    this.lifecycle !== "lead" ||
    this.status !== "active" ||
    !this.nextFollowUpAt
  ) {
    return false;
  }

  return this.nextFollowUpAt.getTime() < Date.now();
});

ClientSchema.set("toJSON", { virtuals: true });
ClientSchema.set("toObject", { virtuals: true });

export type Client = InferSchemaType<typeof ClientSchema>;

export default mongoose.model("Client", ClientSchema);