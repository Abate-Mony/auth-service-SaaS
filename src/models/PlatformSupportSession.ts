import mongoose, { InferSchemaType, Schema } from "mongoose";

// "View as" support access: a platform admin opens a short, read-only,
// reason-stated window onto one company's data (jobs, invoices). Every
// data read under it checks for a live session for that admin + company.
// Expired sessions are kept as history (TTL below removes them after 1 year).
const PlatformSupportSessionSchema = new Schema(
  {
    actor: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    actorEmail: { type: String, required: true },
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    reason: { type: String, required: true, maxlength: 500 },
    expiresAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },
    ownerNotified: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

PlatformSupportSessionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 365 });

export type PlatformSupportSession = InferSchemaType<typeof PlatformSupportSessionSchema>;
export default mongoose.model("PlatformSupportSession", PlatformSupportSessionSchema);
