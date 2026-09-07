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

export type Notification = InferSchemaType<typeof NotificationSchema>;

export default mongoose.model("Notification", NotificationSchema);
