import mongoose, { InferSchemaType, Schema } from "mongoose";

// A worker's regular weekly pattern — "not on Tuesdays", "mornings only".
// One-off absences (holidays, sick days) are TimeOffRequest's job, not
// this. Advisory only: it warns a manager when assigning (see
// getJobAvailability) and narrows who gets open-shift alerts, but never
// blocks an assignment outright.
//
// A worker with no document at all is "not set", not "unavailable" —
// most workers will never fill this in, and that must not hide them.
const AvailabilityDaySchema = new Schema(
  {
    // ISO weekday: 1 = Monday … 7 = Sunday (dayjs isoWeekday()).
    day: { type: Number, required: true, min: 1, max: 7 },
    // "available" — any time; "unavailable" — not at all;
    // "hours" — only between start and end ("HH:mm", same day).
    status: { type: String, enum: ["available", "unavailable", "hours"], default: "available" },
    start: { type: String, default: null },
    end: { type: String, default: null },
  },
  { _id: false }
);

const WorkerAvailabilitySchema = new Schema(
  {
    worker: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    days: { type: [AvailabilityDaySchema], default: [] },
    note: { type: String, default: "", trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

export type WorkerAvailability = InferSchemaType<typeof WorkerAvailabilitySchema>;

export default mongoose.model("WorkerAvailability", WorkerAvailabilitySchema);
