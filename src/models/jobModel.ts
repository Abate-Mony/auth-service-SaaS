import mongoose, { InferSchemaType, Schema } from "mongoose";

const JobSchema = new Schema(
    {
        // ── Identity ──────────────────────────────────────────────────────
        company: { type: String, required: true },
        client: { type: String, trim: true, default: "" },
        title: { type: String, required: true, trim: true },
        description: { type: String, required: true, trim: true },

        // ── Where ─────────────────────────────────────────────────────────
        location: { type: String, required: true, trim: true },
        address: { type: String, default: "", trim: true },
        coordinates: {
            lat: Number,
            lng: Number,
        },
        geofenceRadiusMeters: { type: Number, default: 150 },
        // on JobSchema
        // null = inherit the company setting
        geofenceMode: {
            type: String,
            enum: ["off", "warn", "enforce", null],
            default: null,
        },
        checkInOverriddenBy: { type: Schema.Types.ObjectId, ref: "User" },
        checkInOverrideReason: String,
        // ── When ──────────────────────────────────────────────────────────
        // Always stored as UTC midnight — build it with toUtcDay(), never
        // from local time, or occurrences land a day out.
        date: { type: Date, required: true, index: true },
        startTime: { type: String, required: true }, // "HH:mm"
        endTime: { type: String, required: true },   // "HH:mm"
        // Integer minutes, not float hours. Handles overnight shifts, since
        // the duration already spans the day rollover.
        minutes: { type: Number, required: true, min: 0 },

        // ── State ─────────────────────────────────────────────────────────
        status: {
            type: String,
            enum: ["draft", "published", "completed", "cancelled"],
            default: "draft",
            index: true,
        },
        priority: {
            type: String,
            enum: ["low", "medium", "high", "urgent"],
            default: "medium",
        },
        isDeleted: { type: Boolean, default: false, index: true },

        // ── Staffing ──────────────────────────────────────────────────────
        requiredWorkers: { type: Number, default: 1, min: 1 },
        supervisor: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
        },

        // ── Money ─────────────────────────────────────────────────────────
        payRate: { type: Number, default: 0, min: 0 }, // per hour, to the worker
        chargeType: {
            type: String,
            enum: ["hourly", "fixed"],
            default: "hourly",
        },
        chargeRate: { type: Number, default: 0, min: 0 },   // per hour, when hourly
        chargeAmount: { type: Number, default: 0, min: 0 }, // total, when fixed

        // ── Recurrence ────────────────────────────────────────────────────
        recurringJob: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "RecurringJob",
            default: null,
            index: true,
        },
        // The template a schedule is cloned from — never a real, bookable shift.
        // Excluded from every calendar, list and dashboard query.
        isTemplate: { type: Boolean, default: false, index: true },

        // ── Misc ──────────────────────────────────────────────────────────
        notes: { type: String, default: "", trim: true },
        instructions: { type: String, default: "", trim: true },

        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
    },
    { timestamps: true }
);

// Primary list/calendar query shape
JobSchema.index({ date: 1, status: 1, isDeleted: 1, isTemplate: 1 });

// "Jobs created by this manager"
JobSchema.index({ createdBy: 1, date: -1 });

// Hard backstop against duplicate occurrences for the same recurring
// schedule + date, alongside the app-level dedupe in generateOccurrences.
// Partial so one-off jobs (recurringJob: null) sharing a date don't collide.
JobSchema.index(
    { recurringJob: 1, date: 1 },
    { unique: true, partialFilterExpression: { recurringJob: { $type: "objectId" } } }
);

JobSchema.pre("validate", async function () {
  if (this.chargeType === "fixed" && !this.chargeAmount) {
    throw new Error("chargeAmount is required for fixed-price jobs");
  }
  if (this.chargeType === "hourly" && this.chargeAmount) {
    this.chargeAmount = 0;
  }
});

export type Job = InferSchemaType<typeof JobSchema>;
export default mongoose.model("Job", JobSchema);