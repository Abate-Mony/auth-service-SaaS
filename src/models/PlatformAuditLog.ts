import mongoose, { InferSchemaType, Schema } from "mongoose";

// Immutable record of every platform-admin action. Deliberately its own
// model rather than reusing ActivityLog.ts — that model requires a `job`
// ref and its `type` enum is job/shift-lifecycle-specific, neither of which
// fits a cross-tenant admin action. Never exposed through update/delete
// routes (see platformController.ts) — this table is append-only.
export const PLATFORM_AUDIT_ACTIONS = [
  "company.status.changed",
  "company.plan.changed",
  "user.status.changed",
  "email_domain.retry_verification",
  "email_domain.reset",
  "platform_access.granted",
  "platform_access.revoked",
] as const;
export type PlatformAuditAction = (typeof PLATFORM_AUDIT_ACTIONS)[number];

const PlatformAuditLogSchema = new Schema(
  {
    actor: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    actorEmail: { type: String, required: true },
    actorPlatformRole: { type: String, required: true },

    action: { type: String, enum: PLATFORM_AUDIT_ACTIONS, required: true, index: true },

    targetType: { type: String, required: true },
    targetId: { type: String, required: true },

    company: { type: Schema.Types.ObjectId, ref: "Company", default: null, index: true },

    reason: { type: String, default: null },

    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },

    result: { type: String, enum: ["success", "failed", "denied"], required: true },

    metadata: { type: Schema.Types.Mixed, default: null },

    source: {
      ip: { type: String, default: null },
      userAgent: { type: String, default: null },
    },
  },
  {
    // No updatedAt — these records never change after creation.
    timestamps: { createdAt: true, updatedAt: false },
  }
);

PlatformAuditLogSchema.index({ createdAt: -1 });

export type PlatformAuditLog = InferSchemaType<typeof PlatformAuditLogSchema>;
export default mongoose.model("PlatformAuditLog", PlatformAuditLogSchema);
