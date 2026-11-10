import mongoose, { InferSchemaType, Schema } from "mongoose";

// Persisted record of a failure in one of the three integration points that
// previously only reached console.error: Stripe webhook processing, outbound
// email sending, and scheduled-job runs (see cronRegistry.ts). Append-only
// except for the resolved/resolvedAt/resolvedBy fields a platform admin sets
// after reviewing an entry — mirrors PlatformAuditLog.ts's own "never
// destructively edited" shape, just with one mutable reviewed flag instead of
// none.
export const PLATFORM_ERROR_SOURCES = ["stripe_webhook", "email", "cron"] as const;
export type PlatformErrorSource = (typeof PLATFORM_ERROR_SOURCES)[number];

const PlatformErrorLogSchema = new Schema(
  {
    source: { type: String, enum: PLATFORM_ERROR_SOURCES, required: true, index: true },
    message: { type: String, required: true },
    // Truncated — this is an operator-facing summary, not a full crash
    // dump; the server's own logs still have the untruncated stack.
    stack: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: null },

    resolved: { type: Boolean, default: false, index: true },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

PlatformErrorLogSchema.index({ createdAt: -1 });
PlatformErrorLogSchema.index({ source: 1, resolved: 1 });

export type PlatformErrorLog = InferSchemaType<typeof PlatformErrorLogSchema>;
export default mongoose.model("PlatformErrorLog", PlatformErrorLogSchema);
