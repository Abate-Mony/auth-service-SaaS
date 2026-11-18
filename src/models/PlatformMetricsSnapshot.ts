import mongoose, { InferSchemaType, Schema } from "mongoose";

// One document per UTC calendar day, upserted by captureDailyMetricsSnapshot.ts
// (scheduled daily at 23:55 UTC via cronRegistry.ts, re-runnable manually from
// the platform console). `date` is a "YYYY-MM-DD" string rather than a Date —
// it's the bucket key, not an instant, so this avoids timezone ambiguity when
// querying "the last N days" by string range.
//
// No backfill exists or is possible: nothing in this app snapshotted these
// numbers before this model existed, so the trend this feeds only ever grows
// forward from whenever the first snapshot was captured. PlatformOverview.tsx
// says so explicitly rather than implying a longer history than really exists.
const PlatformMetricsSnapshotSchema = new Schema(
  {
    date: { type: String, required: true, unique: true, index: true },
    companiesTotal: { type: Number, required: true },
    companiesActive: { type: Number, required: true },
    companiesNew: { type: Number, required: true },
    workersActive: { type: Number, required: true },
    jobsCreated: { type: Number, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export type PlatformMetricsSnapshot = InferSchemaType<typeof PlatformMetricsSnapshotSchema>;
export default mongoose.model("PlatformMetricsSnapshot", PlatformMetricsSnapshotSchema);
