import mongoose, { InferSchemaType, Schema } from "mongoose";

// One document per job name in cronRegistry.ts's CRON_JOBS, upserted on
// every run (scheduled or manually triggered via the platform console) by
// runCronJob(). A job that has never run simply has no document here —
// getPlatformCronStatus merges this against the registry so it still shows
// up as "never run" rather than being invisible, per the same "don't show a
// status for something unmonitored as if it were known-good" rule
// PlatformSystem.tsx's own comment states.
const CronJobStatusSchema = new Schema(
  {
    name: { type: String, required: true, unique: true },
    lastRunAt: { type: Date, default: null },
    lastFinishedAt: { type: Date, default: null },
    lastStatus: { type: String, enum: ["success", "failed", "running"], default: null },
    lastDurationMs: { type: Number, default: null },
    lastError: { type: String, default: null },
    lastTriggeredBy: { type: String, enum: ["schedule", "manual"], default: null },
    runCount: { type: Number, default: 0 },
    failCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export type CronJobStatus = InferSchemaType<typeof CronJobStatusSchema>;
export default mongoose.model("CronJobStatus", CronJobStatusSchema);
