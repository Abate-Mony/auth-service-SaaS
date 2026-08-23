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

    autoCompleted: { type: Boolean, default: false },

    cancellationReason: { type: String, default: "", trim: true },
    workerNotes: { type: String, default: "", trim: true },
    managerNotes: { type: String, default: "", trim: true },

    payRate: { type: Number, default: 0, min: 0 },

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