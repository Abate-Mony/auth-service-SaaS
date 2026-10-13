import mongoose, { Schema } from "mongoose";

export type ClientRole = "owner" | "manager" | "booking" | "billing" | "viewer";
export type ClientPortalInvitationStatus = "pending" | "accepted" | "expired" | "revoked";

// Hand-written rather than InferSchemaType'd — same reasoning as
// invitationModel.ts: Mongoose 9 chokes on InferSchemaType with schemas
// that have several similar sibling fields.
export interface ClientPortalInvitationDoc {
  company: mongoose.Types.ObjectId;
  client: mongoose.Types.ObjectId;
  email: string;
  fullname?: string;
  clientRole: ClientRole;
  invitedBy: mongoose.Types.ObjectId;
  tokenHash: string;
  status: ClientPortalInvitationStatus;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedBy?: mongoose.Types.ObjectId | null;
  revokedAt: Date | null;
  revokedBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const ClientPortalInvitationSchema = new Schema<ClientPortalInvitationDoc>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    client: { type: Schema.Types.ObjectId, ref: "Client", required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    fullname: { type: String, trim: true },
    clientRole: { type: String, enum: ["owner", "manager", "booking", "billing", "viewer"], required: true },
    invitedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },

    // Only the hash is ever stored — same pattern as every other token
    // field in this codebase (refreshToken / passwordResetToken /
    // emailVerificationToken / Invitation.tokenHash).
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
    revokedAt: { type: Date, default: null },
    revokedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

// At most one pending invitation per (client, email) — scoped to the
// Client, not the company, since what matters is "does THIS business
// customer already have a pending invite out to this address," not
// uniqueness across the whole tenant. Partial filter means expired/
// revoked/accepted rows for the same pair don't conflict, so invitation
// history is preserved rather than needing to be deleted.
ClientPortalInvitationSchema.index(
  { client: 1, email: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "pending" } }
);

export type ClientPortalInvitation = ClientPortalInvitationDoc;
export default mongoose.model("ClientPortalInvitation", ClientPortalInvitationSchema);
