import mongoose, { InferSchemaType, Schema } from "mongoose";
import { FileRefSchema } from "./shared/fileRefSchema.js";

const JobSchema = new Schema(
    {
        // ── Identity ──────────────────────────────────────────────────────
        company: { type: String, required: true },
        // Optional — internal/training/on-premises work legitimately has no
        // client. Validated + company-scoped in the controller, never
        // trusted as-is from the request.
        client: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Client",
            index: true,
            default: null,
        },
        // Optional — a Site is a reusable client workplace; ad-hoc/one-off
        // jobs legitimately have none and just use location/address below
        // directly. When set, location/address/coordinates/geofenceMode/
        // geofenceRadiusMeters below are filled from the Site at creation
        // time and never re-synced — see siteSnapshot for the rationale.
        site: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Site",
            index: true,
            default: null,
        },
        // Historical facts from the Site as they were at scheduling time,
        // for whatever Site fields Job has no field of its own for
        // (location/address/coordinates/geofence ARE that snapshot, already
        // filled from the Site below — this only covers what's left over).
        // If the Site's name/contact/instructions change later, or the Site
        // is deleted, this job must keep showing what applied when it was
        // scheduled — required for attendance disputes, geofence review,
        // timesheets and audits.
        siteSnapshot: {
            name: String,
            contact: {
                name: String,
                phone: String,
                email: String,
            },
            accessInstructions: String,
            parkingInstructions: String,
        },
        // Set when this Job was created from an accepted Quote — see
        // jobController.ts's resolveSourceQuote, which enforces that the
        // Job's client/site/chargeType/chargeRate/chargeAmount can't diverge
        // from what the client actually accepted. One Quote can produce
        // several Jobs (e.g. a recurring contract), so this lives on Job
        // rather than a createdJobs[] array on Quote — Job.find({sourceQuote})
        // avoids the dual-write consistency problem that array would need.
        sourceQuote: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Quote",
            default: null,
            index: true,
        },
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
        // Lets any worker pick up an unfilled slot themselves instead of
        // waiting to be assigned — see workerController.ts's getOpenShifts/
        // claimOpenShift.
        openToClaims: { type: Boolean, default: false },
        // Whether a self-claim needs a manager's sign-off before it's
        // confirmed (assignment status "pending") or is accepted outright.
        requiresApproval: { type: Boolean, default: true },

        // ── Money ─────────────────────────────────────────────────────────
        payRate: { type: Number, default: 0, min: 0 }, // per hour, to the worker
        chargeType: {
            type: String,
            enum: ["hourly", "fixed"],
            default: "hourly",
        },
        chargeRate: { type: Number, default: 0, min: 0 },   // per hour, when hourly
        chargeAmount: { type: Number, default: 0, min: 0 }, // total, when fixed

        // ── Billing state ─────────────────────────────────────────────────
        // Governs invoicing for FIXED-price jobs only — the whole job is one
        // billable unit there. Hourly jobs are billed per JobAssignment
        // instead (see JobAssignment.billingStatus), since billing there is
        // per-worker-hour: two workers on one job are two separate billable
        // amounts, not one. Ignored for jobs with no client.
        billingStatus: {
            type: String,
            enum: ["not_billable", "pending", "ready", "invoiced"],
            default: "not_billable",
            index: true,
        },
        invoice: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Invoice",
            default: null,
        },

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

        // Optional task list a worker can tick off on-site (e.g. "Clean
        // oven", "Wash client plates") — shared across every worker assigned
        // to the job, not per-worker. Each item gets its own _id
        // (Mongoose's default subdocument behaviour) so a worker can toggle
        // one item without resending the whole list — see
        // toggleJobChecklistItem in workerController.ts.
        checklist: {
            type: [
                {
                    text: { type: String, required: true, trim: true, maxlength: 200 },
                    done: { type: Boolean, default: false },
                    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
                    completedAt: { type: Date, default: null },
                },
            ],
            default: [],
        },

        // Optional single file a manager can attach — e.g. a photo of a door
        // passcode or written access instructions. Visible to assigned
        // workers alongside the job's instructions. Uploaded via its own
        // multipart endpoint (see jobController.ts), never as part of the
        // JSON create/update payload.
        attachment: { type: FileRefSchema, default: null },

        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },

        // Set when this job was created by an external integration (see
        // routes/externalRouter.ts) rather than a manager in the app —
        // createdBy still points at the company owner for these (Job
        // requires a real User), this is what actually distinguishes them.
        createdViaApiKey: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "ApiKey",
            default: null,
        },

        // The caller's own booking/reference id, echoed back on every
        // response so their system can reconcile without storing our id.
        externalReference: { type: String, default: null, trim: true },
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