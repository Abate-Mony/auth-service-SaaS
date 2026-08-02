import mongoose, { InferSchemaType, Schema } from "mongoose";

export const ACTIVITY_TYPES = [
    "job_created",
    "job_updated",
    "job_published",
    "job_cancelled",
    "workers_assigned",       // batch event — one entry even if multiple workers assigned at once
    "assignment_accepted",
    "assignment_declined",
    "assignment_checked_in",
    "assignment_checked_out",
    "assignment_completed",
    "assignment_cancelled",
    "assignment_in_progress",
    "note_added",
] as const;

const ActivityLogSchema = new Schema(
    {
        job: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Job",
            required: true,
            index: true,
        },

        // Optional — set when the event concerns one specific assignment
        // (e.g. "James accepted"), omitted for job-level or batch events
        // (e.g. "Job created", "Workers assigned").
        assignment: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "JobAssignment",
        },

        // For batch events like "Workers assigned" — the set of workers involved
        workers: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User",
            },
        ],

        type: {
            type: String,
            enum: ACTIVITY_TYPES,
            required: true,
        },

        // Who performed the action. Null for system-generated events
        // (e.g. an automated cron marking a job "completed").
        actor: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
        },

        // Free-form extra context (e.g. { reason: "..." } for a decline/cancel),
        // kept flexible so new event types don't need schema migrations.
        metadata: {
            type: Schema.Types.Mixed,
            default: {},
        },
    },
    {
        timestamps: true, // createdAt IS the event timestamp
    }
);

ActivityLogSchema.index({ job: 1, createdAt: -1 }); // timeline is always "this job, newest/oldest first"

export type ActivityLog = InferSchemaType<typeof ActivityLogSchema>;
export default mongoose.model("ActivityLog", ActivityLogSchema);