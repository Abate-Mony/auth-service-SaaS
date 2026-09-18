import mongoose, { InferSchemaType, Schema } from "mongoose";

// ─────────────────────────────────────────────────────────────
// Quote
// ─────────────────────────────────────────────────────────────
// An admin/manager proposes a price to a Client; the client accepts or
// declines via a public, tokenized link (same recipe as Invitation's
// accept flow — see responseTokenHash below). Deliberately its own model
// rather than piggybacking on Job or Invoice: a quote has neither a shift
// nor a payment yet, and may never become either.
const QuoteSchema = new Schema(
  {
    company: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },

    client: {
      type: Schema.Types.ObjectId,
      ref: "Client",
      required: true,
      index: true,
    },

    // Snapshot of the client at quote creation/sending time — a later edit
    // to the Client record must never rewrite a quote's history. Mirrors
    // Invoice.clientSnapshot exactly.
    clientSnapshot: {
      name: {
        type: String,
        required: true,
        trim: true,
      },

      billingEmail: {
        type: String,
        trim: true,
        lowercase: true,
      },

      vatNumber: {
        type: String,
        trim: true,
        uppercase: true,
      },

      phone: {
        type: String,
        trim: true,
      },

      contactName: {
        type: String,
        trim: true,
      },

      address: {
        line1: {
          type: String,
          trim: true,
        },

        line2: {
          type: String,
          trim: true,
        },

        city: {
          type: String,
          trim: true,
        },

        county: {
          type: String,
          trim: true,
        },

        postcode: {
          type: String,
          trim: true,
          uppercase: true,
        },

        country: {
          type: String,
          trim: true,
          default: "United Kingdom",
        },
      },
    },

    site: {
      type: Schema.Types.ObjectId,
      ref: "Site",
      default: null,
    },

    // Only what's left over once clientSnapshot exists — same split
    // rationale as Job.siteSnapshot, but Quote (unlike Job) has no
    // top-level location/address fields of its own, so address lives here
    // rather than being redundant with something else.
    siteSnapshot: {
      name: {
        type: String,
        trim: true,
      },

      contact: {
        name: {
          type: String,
          trim: true,
        },

        phone: {
          type: String,
          trim: true,
        },

        email: {
          type: String,
          trim: true,
          lowercase: true,
        },
      },

      address: {
        line1: {
          type: String,
          trim: true,
        },

        line2: {
          type: String,
          trim: true,
        },

        city: {
          type: String,
          trim: true,
        },

        county: {
          type: String,
          trim: true,
        },

        postcode: {
          type: String,
          trim: true,
          uppercase: true,
        },

        country: {
          type: String,
          trim: true,
        },
      },

      accessInstructions: {
        type: String,
        default: "",
      },

      parkingInstructions: {
        type: String,
        default: "",
      },
    },

    quoteNumber: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    status: {
      type: String,
      enum: ["draft", "sent", "viewed", "accepted", "declined", "expired", "cancelled"],
      default: "draft",
      index: true,
    },

    title: {
      type: String,
      required: true,
      trim: true,
    },

    description: {
      type: String,
      default: "",
    },

    // ── Template ──────────────────────────────────────────────
    // Deliberately the SAME InvoiceTemplate pool Invoice uses (see
    // resolveInvoiceTemplate.ts / resolveQuoteTemplate.ts) rather than a
    // parallel QuoteTemplate collection — a company's brand identity
    // (Modern Navy, Classic Executive, ...) doesn't change between a quote
    // and an invoice, so the 10 presets and any custom templates a company
    // builds are shared. Company.defaultQuoteTemplate can still point at a
    // different one of those same templates than
    // Company.defaultInvoiceTemplate, independently.
    //
    // Same clientSnapshot-style reasoning as Invoice: `template` is a
    // convenience ref only, allowed to dangle; `templateSnapshot` is what
    // quotePdf.ts actually reads, frozen at send time so a company changing
    // its default template later can never alter how an already-sent quote
    // looks if regenerated.
    template: {
      type: Schema.Types.ObjectId,
      ref: "InvoiceTemplate",
      default: null,
    },

    templateSnapshot: {
      name: { type: String, trim: true },
      baseLayout: { type: String, enum: ["modern", "classic", "minimal"] },
      accentColor: { type: String, trim: true },
      font: { type: String, enum: ["Helvetica", "Times-Roman", "Inter"] },
      logoPosition: { type: String, enum: ["top-left", "top-center", "top-right"] },
      showVatBreakdown: { type: Boolean },
      // Reinterpreted per document type by the renderer that reads it —
      // gates the "PAYMENT DETAILS" block on an Invoice, gates a "TERMS"
      // block (quote.terms) here. Same underlying template field either
      // way: "show the closing terms/payment section or not."
      showPaymentTerms: { type: Boolean },
      showNotes: { type: Boolean },
    },

    // ── Billing basis ─────────────────────────────────────────
    // Mirrors Job.chargeType/chargeRate/chargeAmount exactly — this is the
    // canonical number an accepted quote's Job-creation step reads, not
    // something inferred from items[] below. Same field names/shape as Job
    // means that conversion is a direct copy, no translation layer.
    chargeType: {
      type: String,
      enum: ["hourly", "fixed"],
      required: true,
    },

    chargeRate: {
      type: Number,
      default: 0,
      min: 0,
    }, // per hour, when hourly

    chargeAmount: {
      type: Number,
      default: 0,
      min: 0,
    }, // total, when fixed

    // ── Client-facing breakdown ─────────────────────────────────
    // What actually prints on the quote / the public accept page — can be
    // one line (a fixed quote) or several, independent of chargeType
    // above. subtotal/total are derived from this, not from chargeRate/
    // chargeAmount, since a quote can itemize extras (materials, a
    // call-out fee, ...) on top of the core hourly/fixed rate.
    //
    // amount/subtotal/taxAmount/total are always server-computed from
    // quantity/unitPrice/taxRate — never trust these fields raw off a
    // request body.
    items: [
      {
        description: {
          type: String,
          required: true,
        },

        quantity: {
          type: Number,
          required: true,
          default: 1,
          min: 0,
        },

        unitPrice: {
          type: Number,
          required: true,
          min: 0,
        },

        amount: {
          type: Number,
          required: true,
          min: 0,
        },
      },
    ],

    subtotal: {
      type: Number,
      required: true,
      min: 0,
    },

    taxRate: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },

    taxAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    total: {
      type: Number,
      required: true,
      min: 0,
    },

    currency: {
      type: String,
      default: "GBP",
      uppercase: true,
      trim: true,
    },

    validUntil: {
      type: Date,
      required: true,
    },

    notes: {
      type: String,
      default: "",
    },

    terms: {
      type: String,
      default: "",
    },

    // ── Client thank-you email ──────────────────────────────────────
    // Set at creation/edit time (while still draft), read at accept time
    // by respondToPublicQuote — see quoteController.ts. Defaults to true:
    // most companies want this, and it's a checkbox to turn OFF rather
    // than opt into.
    sendThankYouEmailOnAccept: {
      type: Boolean,
      default: true,
    },

    // Not wired to any UI yet — schema placeholder only, per explicit
    // instruction, for a future custom-message-on-thank-you-email update.
    // Empty string means "use the default thank-you copy."
    thankYouMessage: {
      type: String,
      trim: true,
      default: "",
    },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    sentAt: Date,
    // First-sent timestamp — never overwritten on resend, unlike lastSentAt
    // below. Same split as Invoice's own sentAt/lastSentAt.
    lastSentAt: Date,
    viewedAt: Date,

    acceptedAt: Date,
    declinedAt: Date,

    declineReason: {
      type: String,
      default: "",
      trim: true,
    },

    acceptedBy: {
      name: {
        type: String,
        trim: true,
      },

      email: {
        type: String,
        trim: true,
        lowercase: true,
      },
    },

    declinedBy: {
      name: {
        type: String,
        trim: true,
      },

      email: {
        type: String,
        trim: true,
        lowercase: true,
      },
    },

    // Only the hash is ever stored — same pattern as Invitation.tokenHash /
    // refreshToken / passwordResetToken elsewhere in this codebase. Paired
    // with an expiry so the public accept/decline route can reject a stale
    // link instead of trusting a hash match alone.
    responseTokenHash: {
      type: String,
      default: null,
      select: false,
    },

    responseTokenExpiresAt: {
      type: Date,
      default: null,
    },

    // ── Cancellation ──────────────────────────────────────────
    // Distinct from declinedBy/declinedAt above — this is the agency
    // withdrawing its own quote, not the client's response to it. Mirrors
    // Invoice.cancelledAt/cancelledBy/cancellationReason exactly.
    cancelledAt: {
      type: Date,
      default: null,
    },

    cancelledBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    cancellationReason: {
      type: String,
      trim: true,
      default: "",
      maxlength: 1000,
    },

    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// Quote numbers are unique within each company; different companies may
// reuse the same human-readable number.
QuoteSchema.index({ company: 1, quoteNumber: 1 }, { unique: true });

// Matches the quotes list page's actual query shape: company-scoped,
// excluding soft-deleted, filtered by status, newest first.
QuoteSchema.index({ company: 1, isDeleted: 1, status: 1, createdAt: -1 });

// Keeps chargeRate/chargeAmount internally consistent with chargeType —
// same style as Job's own pre("validate") hook, but stricter: unlike Job
// (where plenty of jobs are legitimately non-billable), a Quote's entire
// purpose is proposing a real price, so 0 is never valid on the active side.
//
// NOTE: pre("validate") is document middleware — it runs on .create()/
// .save(), but NOT on findByIdAndUpdate/updateOne even with
// runValidators: true (Job's own updateJob controller has this same gap
// today). Any future updateQuote controller must fetch-then-.save() if
// this hook should apply to edits, not just creation.
QuoteSchema.pre("validate", function () {
  if (this.chargeType === "fixed") {
    if (!this.chargeAmount || this.chargeAmount <= 0) {
      throw new Error("chargeAmount must be greater than 0 for fixed-price quotes");
    }
    this.chargeRate = 0;
  }

  if (this.chargeType === "hourly") {
    if (!this.chargeRate || this.chargeRate <= 0) {
      throw new Error("chargeRate must be greater than 0 for hourly quotes");
    }
    this.chargeAmount = 0;
  }
});

export type Quote = InferSchemaType<typeof QuoteSchema>;

export default mongoose.model("Quote", QuoteSchema);
