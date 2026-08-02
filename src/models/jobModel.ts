import mongoose, { InferSchemaType, Schema } from "mongoose";

const JobSchema = new Schema(
  {
    company: {
      type: String,
      required: true,
    },
    client: { type: String, trim: true, default: "" },
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    location: { type: String, required: true, trim: true },
    address: { type: String, default: "", trim: true },
    date: { type: Date, required: true, index: true },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    hours: { type: Number, required: true, min: 0 },

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

    requiredWorkers: { type: Number, default: 1, min: 1 },

    supervisor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    payRate: { type: Number, default: 0, min: 0 },
    chargeRate: { type: Number, default: 0, min: 0 },

    recurringJob: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RecurringJob",
      default: null,
      index: true,
    },

    notes: { type: String, default: "", trim: true },
    instructions: { type: String, default: "", trim: true },
    isPublished: { type: Boolean, default: false },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

JobSchema.index({ company: 1, date: 1, status: 1 });

export type Job = InferSchemaType<typeof JobSchema>;
export default mongoose.model("Job", JobSchema);