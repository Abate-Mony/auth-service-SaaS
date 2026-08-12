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
        // location: { type: String, required: true, trim: true },
        // address: { type: String, default: "", trim: true },
        date: { type: Date, required: true, index: true },
        startTime: { type: String, required: true },  // "HH:mm"
        endTime: { type: String, required: true },    // "HH:mm"
        minutes: { type: Number, required: true, min: 0 },
        // hours: { type: Number, required: true, min: 0 },
        isDeleted: {
            type: Boolean,
            default: false
        },
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
   isTemplate: { type: Boolean, default: false, index: true },
        notes: { type: String, default: "", trim: true },
        instructions: { type: String, default: "", trim: true },
        isPublished: { type: Boolean, default: false },

        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        location: { type: String, required: true, trim: true },
        address: { type: String, default: "", trim: true },
        coordinates: {
            lat: Number,
            lng: Number,
        },
    },
    { timestamps: true }
);

JobSchema.index({ company: 1, date: 1, status: 1 });

// Hard backstop against duplicate occurrences for the same recurring
// schedule + date (belt-and-braces alongside the app-level dedupe in
// generateOccurrences.ts). Partial so one-off jobs (recurringJob: null)
// sharing a date don't collide.
JobSchema.index(
    { recurringJob: 1, date: 1 },
    { unique: true, partialFilterExpression: { recurringJob: { $type: "objectId" } } }
);

export type Job = InferSchemaType<typeof JobSchema>;
export default mongoose.model("Job", JobSchema);