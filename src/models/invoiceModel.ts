import mongoose, {
  InferSchemaType,
  Schema,
} from "mongoose";

const InvoiceLineItemSchema = new Schema(
  {
    description: {
      type: String,
      required: true,
      trim: true,
    },

    type: {
      type: String,
      enum: [
        "hourly",
        "fixed",
        "adjustment",
      ],
      default: "hourly",
    },

    job: {
      type: Schema.Types.ObjectId,
      ref: "Job",
      default: null,
    },

    // For hourly billing
    minutes: {
      type: Number,
      min: 0,
      default: 0,
    },

    // For fixed/manual quantity-based billing
    quantity: {
      type: Number,
      min: 0,
      default: 1,
    },

    // Store in pounds for now.
    // If you want stricter money handling later,
    // migrate to integer pence.
    rate: {
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
  {
    _id: false,
  }
);

const InvoiceSchema = new Schema(
  {
    // ── Scoping ─────────────────────────────────────────────

    company: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // ── Identity ────────────────────────────────────────────

    invoiceNumber: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    currency: {
      type: String,
      default: "GBP",
      uppercase: true,
      trim: true,
    },

    // ── Client ──────────────────────────────────────────────

    client: {
      type: Schema.Types.ObjectId,
      ref: "Client",
      required: true,
      index: true,
    },

    /**
     * Snapshot of the client at invoice creation/sending time.
     *
     * This prevents historical invoices changing later if the
     * Client record is edited.
     */
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

    // ── Related Jobs ────────────────────────────────────────

    /**
     * One invoice may contain:
     *
     * - one Job
     * - several Jobs
     * - a weekly/monthly billing period
     */
    jobs: [
      {
        type: Schema.Types.ObjectId,
        ref: "Job",
      },
    ],

    // ── Dates ───────────────────────────────────────────────

    issueDate: {
      type: Date,
      required: true,
      index: true,
    },

    dueDate: {
      type: Date,
      required: true,
      index: true,
    },

    /**
     * Useful when an invoice covers multiple shifts.
     *
     * Example:
     * 1 Aug – 31 Aug
     */
    servicePeriod: {
      start: {
        type: Date,
      },

      end: {
        type: Date,
      },
    },

    // ── Client Reference / PO ───────────────────────────────

    purchaseOrderNumber: {
      type: String,
      trim: true,
    },

    // ── Line Items ──────────────────────────────────────────

    lineItems: {
      type: [InvoiceLineItemSchema],
      default: [],
    },

    // ── Totals ──────────────────────────────────────────────

    subtotal: {
      type: Number,
      required: true,
      min: 0,
    },

    vatRate: {
      type: Number,
      default: 20,
      min: 0,
    },

    vatAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    total: {
      type: Number,
      required: true,
      min: 0,
    },

    /**
     * Supports partial payments later.
     */
    amountPaid: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ── Invoice Lifecycle ───────────────────────────────────

    /**
     * Overdue should preferably be derived from:
     *
     * status === "sent"
     * dueDate < now
     * amountPaid < total
     *
     * rather than persisted as a separate state.
     */
    status: {
      type: String,
      enum: [
        "draft",
        "sent",
        "paid",
        "cancelled",
      ],
      default: "draft",
      index: true,
    },

    // ── Sending ─────────────────────────────────────────────

    sentAt: {
      type: Date,
      default: null,
    },

    lastSentAt: {
      type: Date,
      default: null,
    },

    sentTo: [
      {
        type: String,
        trim: true,
        lowercase: true,
      },
    ],

    // ── Payment ─────────────────────────────────────────────

    paidAt: {
      type: Date,
      default: null,
    },

    paymentReference: {
      type: String,
      trim: true,
    },

    paymentMethod: {
      type: String,
      enum: [
        "bank_transfer",
        "card",
        "cash",
        "direct_debit",
        "other",
      ],
    },

    paymentNotes: {
      type: String,
      trim: true,
      default: "",
      maxlength: 2000,
    },

    // ── Cancellation ────────────────────────────────────────

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

    // ── Notes ───────────────────────────────────────────────

    notes: {
      type: String,
      trim: true,
      default: "",
      maxlength: 2000,
    },

    // ── Soft Delete ─────────────────────────────────────────

    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,

    toJSON: {
      virtuals: true,
    },

    toObject: {
      virtuals: true,
    },
  }
);

// ─────────────────────────────────────────────────────────────
// Indexes
// ─────────────────────────────────────────────────────────────

InvoiceSchema.index(
  {
    company: 1,
    invoiceNumber: 1,
  },
  {
    unique: true,
  }
);

InvoiceSchema.index({
  company: 1,
  status: 1,
  dueDate: 1,
});

InvoiceSchema.index({
  company: 1,
  client: 1,
  issueDate: -1,
});

InvoiceSchema.index({
  company: 1,
  createdAt: -1,
});

InvoiceSchema.index({
  jobs: 1,
});

// ─────────────────────────────────────────────────────────────
// Virtuals
// ─────────────────────────────────────────────────────────────

/**
 * Remaining unpaid amount.
 */
InvoiceSchema.virtual("balanceDue").get(function (
  this: any
) {
  return Math.max(
    0,
    (this.total ?? 0) -
      (this.amountPaid ?? 0)
  );
});

/**
 * Overdue is derived instead of stored.
 */
InvoiceSchema.virtual("isOverdue").get(function (
  this: any
) {
  if (this.status !== "sent") {
    return false;
  }

  if (!this.dueDate) {
    return false;
  }

  return (
    new Date(this.dueDate) <
      new Date() &&
    (this.amountPaid ?? 0) <
      (this.total ?? 0)
  );
});

/**
 * Useful frontend-facing display status.
 */
InvoiceSchema.virtual("displayStatus").get(
  function (this: any) {
    if (
      this.status === "sent" &&
      this.isOverdue
    ) {
      return "overdue";
    }

    return this.status;
  }
);

// ─────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────

InvoiceSchema.pre("validate", async function () {
  if (this.dueDate && this.issueDate && this.dueDate < this.issueDate) {
    throw new Error("Due date cannot be before issue date");
  }

  if (
    this.servicePeriod?.start &&
    this.servicePeriod?.end &&
    this.servicePeriod.end < this.servicePeriod.start
  ) {
    throw new Error("Service period end cannot be before start");
  }

  if ((this.amountPaid ?? 0) > (this.total ?? 0)) {
    throw new Error("Amount paid cannot exceed invoice total");
  }
});

// ─────────────────────────────────────────────────────────────
// Type
// ─────────────────────────────────────────────────────────────

export type Invoice =
  InferSchemaType<
    typeof InvoiceSchema
  >;

// ─────────────────────────────────────────────────────────────
// Model
// ─────────────────────────────────────────────────────────────

export default mongoose.model(
  "Invoice",
  InvoiceSchema
);