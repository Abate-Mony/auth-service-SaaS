import mongoose, { InferSchemaType, Schema } from "mongoose";

const JobAssignmentSchema = new Schema(
  {

    fullname: { type: String, required: [true, "please fullname is require for queries"] },
    job: { type: Schema.Types.ObjectId, ref: "Job", required: true, index: true },
    worker: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },

    status: {
      type: String,
      enum: ["pending", "accepted", "declined", "in-progress", "completed", "cancelled"],
      default: "pending",
      index: true,
    },
    // adde new field to track the company associated with the job assignment
    // needs migration later to populate this field for existing job assignments
    cancelledAt: Date,

    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },


    cancellationType: {
      type: String,
      enum: ["manager", "worker", "job"],
    },
//new fiels end here 
    company: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      required: true
    },
    acceptedAt: Date,
    declinedAt: Date,
    checkedInAt: Date,
    checkedOutAt: Date,
    completedAt: Date,

    checkInLocation: { lat: Number, lng: Number, accuracy: Number },
    checkOutLocation: { lat: Number, lng: Number, accuracy: Number },

    breaks: [{ startedAt: Date, endedAt: Date }],

    // Set when the shift is force-closed by the auto-clock-out cron instead
    // of the worker tapping "clock out" themselves.
    autoCompleted: { type: Boolean, default: false },

    // Set on a self-claimed open shift whose job has requiresApproval: true.
    // status stays "pending" (same enum value used for "worker hasn't
    // responded yet"), but here the pending party is the manager, not the
    // worker — this flag is what lets the two cases be told apart.
    pendingApproval: { type: Boolean, default: false },

    // ── Overtime / late clock-out review ──────────────────────────────
    // actualMinutes: raw checkedIn→checkedOut time, minus breaks — what
    // really happened, for the record. Never capped by the job's scheduled
    // duration (job.minutes is the schedule, not a ceiling on reality).
    // approvedMinutes: what payroll should actually pay for. Set to
    // actualMinutes at clock-out, whether or not the shift ran long —
    // overtimeStatus "pending" only flags it for a manager's attention.
    // Only that manager's own decision (reviewAssignmentOvertime's "reject"
    // or "adjust") should ever move this below actualMinutes.
    actualMinutes: { type: Number, default: null },
    approvedMinutes: { type: Number, default: null },
    overtimeMinutes: { type: Number, default: 0 },
    overtimeStatus: {
      type: String,
      enum: ["none", "pending", "approved", "rejected"],
      default: "none",
      index: true,
    },
    clockOutReason: {
      type: String,
      enum: ["on_time", "job_took_longer", "manager_asked_to_stay", "forgot_to_clock_out", "auto_closed", "other"],
    },
    clockOutNote: { type: String, default: "", trim: true },
    overtimeReviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    overtimeReviewedAt: Date,

    cancellationReason: { type: String, default: "", trim: true },
    workerNotes: { type: String, default: "", trim: true },
    managerNotes: { type: String, default: "", trim: true },

    payRate: { type: Number, default: 0, min: 0 },

    // ── Billing state ─────────────────────────────────────────────────
    // Governs invoicing for HOURLY-priced jobs — each worker's completed,
    // approved-time shift is its own billable unit (confirmed billing
    // model: per worker-hour, not per shift-hour). Fixed-price jobs are
    // billed at the Job level instead (see Job.billingStatus).
    billingStatus: {
      type: String,
      enum: ["not_billable", "pending", "ready", "invoiced"],
      default: "not_billable",
      index: true,
    },
    invoice: {
      type: Schema.Types.ObjectId,
      ref: "Invoice",
      default: null,
    },

    isDeleted: { type: Boolean, default: false },

    // Set once the "shift starts in 30 minutes" email goes out, so the
    // reminder cron never emails the same worker twice for the same shift.
    reminderSentAt: { type: Date, default: null },
    checkInDistanceMeters: Number,
    checkInFlagged: { type: Boolean, default: false, index: true },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

JobAssignmentSchema.index({ job: 1, worker: 1 }, { unique: true });
JobAssignmentSchema.index({ worker: 1, status: 1 });
JobAssignmentSchema.index({ worker: 1, createdAt: -1 });

JobAssignmentSchema.virtual("workedMinutes").get(function (this: any) {
  if (!this.checkedInAt || !this.checkedOutAt) return 0;
  const gross = Math.round((this.checkedOutAt - this.checkedInAt) / 60000);
  const breakMins = (this.breaks ?? []).reduce(
    (sum: number, b: any) => b.endedAt ? sum + Math.round((b.endedAt - b.startedAt) / 60000) : sum,
    0
  );
  return Math.max(0, gross - breakMins);
});
export type JobAssignment = InferSchemaType<
  typeof JobAssignmentSchema
>;

export default mongoose.model(
  "JobAssignment",
  JobAssignmentSchema
);