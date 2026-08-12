import mongoose, { InferSchemaType, Schema } from "mongoose";

export const ACTIVITY_TYPES = [
  "job_created",
  "job_updated",
  "job_published",
  "job_cancelled",
  "job_deleted",
  "workers_assigned",
  "worker_unassigned",
  "assignment_accepted",
  "assignment_declined",
  "assignment_in_progress",
  "assignment_checked_in",
  "assignment_break_started",
  "assignment_break_ended",
  "assignment_checked_out",
  "assignment_completed",
  "assignment_cancelled",
  "assignment_auto_completed",
  "note_added",
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

const ActivityLogSchema = new Schema(
  {
    type: {
      type: String,
      enum: ACTIVITY_TYPES,
      required: true,
      index: true,
    },

    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Job",
      required: true,
      index: true,
    },

    assignment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "JobAssignment",
      index: true,
    },

    // Denormalised: the single worker a per-assignment event concerns.
    // Lets you query "everything Priya did" without joining through
    // JobAssignment, which is the read you'll want most often.
    worker: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },

    // Batch events only (workers_assigned) — the set involved
    workers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

    // Null for system-generated events (cron auto-completion)
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },

    // Set when the actor is the system rather than a person, so you can
    // filter machine events out of a human-facing timeline
    isSystem: { type: Boolean, default: false, index: true },

    // Denormalised job date — lets you filter activity by the day the work
    // happened rather than the day it was logged. A shift edited a week
    // early would otherwise be invisible in "activity for last Tuesday".
    jobDate: { type: Date, index: true },

    // Structured before/after for *_updated events, so you can render
    // "priority: medium → urgent" without diffing anything at read time
    changes: [
      {
        field: String,
        from: Schema.Types.Mixed,
        to: Schema.Types.Mixed,
        _id: false,
      },
    ],

    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

// Job timeline — the primary read
ActivityLogSchema.index({ job: 1, createdAt: -1 });

// "What has this worker been doing?" — worker activity feed
ActivityLogSchema.index({ worker: 1, createdAt: -1 });

// Company-wide recent activity for the dashboard panel
ActivityLogSchema.index({ createdAt: -1 });

// Filtered feeds, e.g. all check-ins in a date range
ActivityLogSchema.index({ type: 1, createdAt: -1 });

// Optional: expire old logs so this collection doesn't grow forever.
// 2 years. Remove if you need permanent audit history.
ActivityLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 730 });

export type ActivityLog = InferSchemaType<typeof ActivityLogSchema>;
export default mongoose.model("ActivityLog", ActivityLogSchema);