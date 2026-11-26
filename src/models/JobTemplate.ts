import mongoose, { Schema } from "mongoose";

// A reusable starting point for a job ("Deep clean", "Oven clean"): the
// details that repeat, never the ones that change (client, site, date,
// workers). Picking one on Create Job fills the form; nothing is scheduled.
//
// Deliberately its own collection rather than a Job with a flag: Jobs with
// isTemplate: true already mean "a recurring schedule's hidden template",
// and many queries (calendar, reports, invoicing) filter those out by hand.
// Keeping these out of the jobs collection means none of them can leak.
export const TEMPLATE_ICONS = ["spray", "sparkles", "home", "bed", "building", "window", "flame", "tooth", "truck", "leaf", "wrench", "briefcase"] as const;

const JobTemplateSchema = new Schema(
    {
        company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
        // What managers pick from ("Deep clean").
        name: { type: String, required: true, trim: true, maxlength: 80 },
        // One line under the name on the card.
        summary: { type: String, default: "", trim: true, maxlength: 140 },
        icon: { type: String, enum: TEMPLATE_ICONS, default: "sparkles" },

        // ── What gets copied onto the new job ─────────────────
        title: { type: String, required: true, trim: true, maxlength: 200 },
        description: { type: String, default: "", trim: true, maxlength: 5000 },
        priority: { type: String, enum: ["low", "medium", "high", "urgent"], default: "medium" },
        // Optional usual hours, "HH:mm". The date is always chosen per job.
        startTime: { type: String, default: "" },
        endTime: { type: String, default: "" },
        requiredWorkers: { type: Number, default: 1, min: 1, max: 50 },
        payRate: { type: Number, default: 0, min: 0 },
        chargeType: { type: String, enum: ["hourly", "fixed"], default: "hourly" },
        chargeRate: { type: Number, default: 0, min: 0 },
        chargeAmount: { type: Number, default: 0, min: 0 },
        instructions: { type: String, default: "", trim: true, maxlength: 5000 },
        notes: { type: String, default: "", trim: true, maxlength: 5000 },
        checklist: {
            type: [{ _id: false, text: { type: String, required: true, trim: true, maxlength: 200 } }],
            default: [],
        },
        openToClaims: { type: Boolean, default: false },
        requiresApproval: { type: Boolean, default: true },
        autoAccept: { type: Boolean, default: false },

        // ── Bookkeeping ───────────────────────────────────────
        useCount: { type: Number, default: 0 },
        lastUsedAt: { type: Date, default: null },
        createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
        isDeleted: { type: Boolean, default: false },
    },
    { timestamps: true }
);

// One "Deep clean" per company (among live templates).
JobTemplateSchema.index(
    { company: 1, name: 1 },
    { unique: true, partialFilterExpression: { isDeleted: false }, collation: { locale: "en", strength: 2 } }
);

export default mongoose.model("JobTemplate", JobTemplateSchema);
