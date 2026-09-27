import mongoose, { InferSchemaType, Schema } from "mongoose";

// A manager/admin's personal, persistent inbox — distinct from ActivityLog
// (which is per-job and shared with anyone who opens that job). Push
// notifications are fire-and-forget; this is what lets someone catch up on
// what they missed. Written at the same points a push already fires (see
// utils/notifyUser.ts), gated by that user's own "inApp" channel preference.
const NotificationSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true },
    type: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    link: { type: String, default: null },
    isRead: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

NotificationSchema.index({ user: 1, createdAt: -1 });

// This is the "did you see this yet" inbox, not the durable record —
// ActivityLog already keeps a 2-year audit trail of everything that
// actually happened. Nothing is lost when one of these expires, so it's
// kept short to bound growth on a small shared MongoDB tier.
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export type Notification = InferSchemaType<typeof NotificationSchema>;

export default mongoose.model("Notification", NotificationSchema);
