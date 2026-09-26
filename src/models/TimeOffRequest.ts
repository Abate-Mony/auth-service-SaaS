import mongoose, { Schema } from "mongoose";

const TimeOffRequestSchema = new Schema(
    {
        worker: { type: Schema.Types.ObjectId, ref: "User", required: true },
        company: { type: Schema.Types.ObjectId, ref: "Company", required: true },

        // Whole-day range, inclusive on both ends — matches how a worker
        // thinks about time off ("Dec 24 through Dec 26"), not shift-level
        // start/end times.
        startDate: { type: Date, required: true },
        endDate: { type: Date, required: true },

        type: {
            type: String,
            enum: ["vacation", "sick", "personal", "other"],
            default: "other",
        },
        reason: { type: String, default: "", trim: true, maxlength: 500 },

        status: {
            type: String,
            enum: ["pending", "approved", "rejected", "cancelled"],
            default: "pending",
            index: true,
        },
        reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
        reviewedAt: Date,
        managerNotes: { type: String, default: "", trim: true, maxlength: 500 },

        isDeleted: { type: Boolean, default: false },
    },
    { timestamps: true }
);

TimeOffRequestSchema.index({ company: 1, status: 1, startDate: 1 });
TimeOffRequestSchema.index({ worker: 1, status: 1, createdAt: -1 });

export default mongoose.model("TimeOffRequest", TimeOffRequestSchema);
