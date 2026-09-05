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

    // Several contacts is the norm — one for operations, one for accounts.
    // A single nested object would need migrating the first time that happens.
    contacts: [
      {
        name: { type: String, trim: true },
        role: { type: String, trim: true }, // "Site Manager", "Accounts"
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

    // Prefills new jobs and invoices for this client, so a manager isn't
    // retyping the same rate on every shift for the same account.
    defaultChargeType: {
      type: String,
      enum: ["hourly", "fixed"],
      default: "hourly",
    },
    defaultChargeRate: { type: Number, default: 0, min: 0 },
    paymentTermsDays: { type: Number, default: 30, min: 0 },

    // ── State ─────────────────────────────────────────────────────────
    // status = the commercial relationship; isDeleted = created by mistake.
    // Queries listing clients filter on both.
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
      index: true,
    },
    isDeleted: { type: Boolean, default: false, index: true },

    // ── Misc ──────────────────────────────────────────────────────────
    notes: { type: String, trim: true, default: "", maxlength: 2000 },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

// Primary list query shape
ClientSchema.index({ company: 1, status: 1, isDeleted: 1 });

// The unique index below on the same {company, name} shape already serves
// the job-form typeahead query — a second plain index here was redundant
// (Mongoose warned: "Duplicate schema index").

// No two live clients with the same name in one company — stops "Tesco Extra"
// and "Tesco Extra" becoming separate accounts. Partial so a soft-deleted
// client doesn't block recreating the name.
ClientSchema.index(
  { company: 1, name: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false },
  }
);

// Exactly one primary contact
ClientSchema.pre("validate", async function () {
  const primaries = (this.contacts ?? []).filter(c => c.isPrimary);
  if (primaries.length > 1) {
    throw new Error("Only one contact can be marked as primary");
  }
  if (!primaries.length && this.contacts?.length) {
    this.contacts[0].isPrimary = true;
  }
});

// Convenience for invoices and list rows
ClientSchema.virtual("primaryContact").get(function (this: any) {
  return (this.contacts ?? []).find((c: any) => c.isPrimary) ?? this.contacts?.[0] ?? null;
});

ClientSchema.virtual("formattedAddress").get(function (this: any) {
  const a = this.address ?? {};
  return [a.line1, a.line2, a.city, a.county, a.postcode, a.country]
    .filter(Boolean)
    .join(", ");
});

ClientSchema.set("toJSON", { virtuals: true });
ClientSchema.set("toObject", { virtuals: true });

export type Client = InferSchemaType<typeof ClientSchema>;
export default mongoose.model("Client", ClientSchema);