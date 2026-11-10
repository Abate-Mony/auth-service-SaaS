import mongoose, { InferSchemaType, Schema } from "mongoose";

// A message a platform admin pushes to tenant dashboards (maintenance
// windows, incident notices, etc.) — see announcementController.ts for the
// tenant-facing read side. No hard delete: matches this codebase's existing
// preference for status toggles over destructive deletes (e.g. Company's
// own status field rather than a deleteCompany endpoint) — isActive:false is
// the only way an announcement stops being shown.
export const ANNOUNCEMENT_SEVERITIES = ["info", "warning", "critical"] as const;
export type AnnouncementSeverity = (typeof ANNOUNCEMENT_SEVERITIES)[number];

export const ANNOUNCEMENT_AUDIENCES = ["all", "plan", "company"] as const;
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];

const PlatformAnnouncementSchema = new Schema(
  {
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    severity: { type: String, enum: ANNOUNCEMENT_SEVERITIES, default: "info" },

    audience: { type: String, enum: ANNOUNCEMENT_AUDIENCES, default: "all" },
    // Only meaningful when audience === "plan" / "company" respectively —
    // left empty otherwise. Not validated against each other at the schema
    // level; announcementController.ts's active-announcement query only
    // ever reads the array matching the document's own `audience`.
    targetPlans: { type: [String], default: [] },
    targetCompanies: [{ type: Schema.Types.ObjectId, ref: "Company" }],

    startsAt: { type: Date, default: () => new Date() },
    // null = indefinite, no scheduled end.
    endsAt: { type: Date, default: null },
    // Manual kill-switch independent of the date window — lets an admin
    // pull an announcement immediately without needing to know/guess what
    // endsAt would retroactively need to be.
    isActive: { type: Boolean, default: true },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

PlatformAnnouncementSchema.index({ isActive: 1, startsAt: 1, endsAt: 1 });

export type PlatformAnnouncement = InferSchemaType<typeof PlatformAnnouncementSchema>;
export default mongoose.model("PlatformAnnouncement", PlatformAnnouncementSchema);
