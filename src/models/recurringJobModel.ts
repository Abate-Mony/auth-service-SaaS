// models/RecurringJob.ts
import mongoose, { InferSchemaType, Schema } from "mongoose";

const RecurringJobSchema = new Schema(
  {
    // The job used as a template — cloned into new Job docs on each occurrence
    templateJob: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Job",
      required: true,
    },

    frequency: {
      type: String,
      enum: ["daily", "weekly", "monthly"],
      required: true,
    },

    interval: {
      type: Number,
      default: 1,
      min: 1,
    },

    // Only meaningful when frequency === "weekly"; 0 = Sunday .. 6 = Saturday
    daysOfWeek: {
      type: [Number],
      validate: {
        validator: (arr: number[]) => arr.every(d => d >= 0 && d <= 6),
        message: "daysOfWeek values must be between 0 and 6",
      },
    },

    startDate: {
      type: Date,
      required: true,
    },

    endDate: Date,

    // How far in advance job occurrences have actually been created
    generatedUntil: {
      type: Date,
    },

    active: {
      type: Boolean,
      default: true,
      index: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

RecurringJobSchema.index({ active: 1 });

RecurringJobSchema.pre("validate", function (next) {
  if (this.frequency === "weekly" && (!this.daysOfWeek || this.daysOfWeek.length === 0)) {
    return next(new Error("daysOfWeek is required when frequency is weekly"));
  }
  if (this.endDate && this.startDate && this.endDate < this.startDate) {
    return next(new Error("endDate cannot be before startDate"));
  }
  next();
});

export type RecurringJob = InferSchemaType<typeof RecurringJobSchema>;
export default mongoose.model("RecurringJob", RecurringJobSchema);