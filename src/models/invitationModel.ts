import mongoose, { Schema } from "mongoose";

export type InvitationRole = "worker" | "manager";
export type InvitationStatus = "pending" | "accepted" | "expired" | "revoked";

// Hand-written rather than InferSchemaType'd — this codebase has already
// hit Mongoose 9's InferSchemaType choking on schemas with several similar
// sibling fields, so an explicit interface sidesteps that class of bug.
export interface InvitationDoc {
  company: mongoose.Types.ObjectId;
  email: string;
  fullname?: string;
  phone?: string;
  role: InvitationRole;
  invitedBy: mongoose.Types.ObjectId;
  tokenHash: string;
  status: InvitationStatus;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedBy?: mongoose.Types.ObjectId | null;
  // No Site model exists in this codebase yet — stored as bare ObjectIds
  // with no `ref`/cross-collection validation until one does.
  sites?: mongoose.Types.ObjectId[];
  payRate?: number;
  employeeId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const InvitationSchema = new Schema<InvitationDoc>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    fullname: { type: String, trim: true },
    phone: { type: String, trim: true },
    role: { type: String, enum: ["worker", "manager"], required: true },
    invitedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },

    // Only the hash is ever stored — same pattern as refreshToken /
    // passwordResetToken / emailVerificationToken elsewhere in this codebase.
    tokenHash: { type: String, required: true, select: false },

    status: {
      type: String,
      enum: ["pending", "accepted", "expired", "revoked"],
      default: "pending",
      index: true,
    },
    expiresAt: { type: Date, required: true },
    acceptedAt: { type: Date, default: null },
    acceptedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },

    sites: [{ type: Schema.Types.ObjectId }],
    payRate: { type: Number, min: 0 },
    employeeId: { type: String, trim: true },
  },
  { timestamps: true }
);

// At most one pending invitation per (company, email) — the partial filter
// means expired/revoked/accepted rows for the same pair don't conflict, so
// invitation history is preserved rather than needing to be deleted.
InvitationSchema.index(
  { company: 1, email: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "pending" } }
);

export type Invitation = InvitationDoc;
export default mongoose.model("Invitation", InvitationSchema);
