// models/RecurringJob.ts
import mongoose, { InferSchemaType, Schema } from "mongoose";

const RecurringJobSchema = new Schema(
  {
    templateJob: { type: Schema.Types.ObjectId, ref: "Job", required: true },

    frequency: { type: String, enum: ["daily", "weekly", "monthly"], required: true },
    interval: { type: Number, default: 1, min: 1 },
    daysOfWeek: {
      type: [Number],
      validate: {
        validator: (a: number[]) => a.every(d => d >= 0 && d <= 6),
        message: "daysOfWeek values must be 0–6",
      },
    },
    monthlyMode: { type: String, enum: ["day-of-month", "day-of-week"], default: "day-of-month" },
    monthlyWeekNum: { type: Number, min: 1, max: 5 },
    monthlyWeekDay: { type: Number, min: 0, max: 6 },

    startDate: { type: Date, required: true },
    endDate: Date,
    maxOccurrences: { type: Number, min: 1 },
    occurrencesGenerated: { type: Number, default: 0 },
    generatedUntil: Date,

    defaultWorkers: [{ type: Schema.Types.ObjectId, ref: "User" }],

    active: { type: Boolean, default: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

RecurringJobSchema.index({ active: 1 });

RecurringJobSchema.pre("validate", function () {
  if (this.frequency === "weekly" && (!this.daysOfWeek || this.daysOfWeek.length === 0)) {
    throw new Error("daysOfWeek is required when frequency is weekly");
  }
  if (this.endDate && this.startDate && this.endDate < this.startDate) {
    throw new Error("endDate cannot be before startDate");
  }
});

export type RecurringJob = InferSchemaType<typeof RecurringJobSchema>;
export default mongoose.model("RecurringJob", RecurringJobSchema);