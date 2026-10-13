import mongoose, { Schema } from "mongoose";

// Unlike BookingRequest/TimeOffRequest, which both create a brand-new record
// on approval, this request targets an EXISTING Job to be mutated — `job` is
// the record approval acts on, not just a scoping field.
const JobChangeRequestSchema = new Schema(
    {
        company: { type: Schema.Types.ObjectId, ref: "Company", required: true },
        client: { type: Schema.Types.ObjectId, ref: "Client", required: true },
        job: { type: Schema.Types.ObjectId, ref: "Job", required: true, index: true },
        requestedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },

        type: { type: String, enum: ["reschedule", "cancel"], required: true },

        // Only meaningful/validated-in-controller when type === "reschedule".
        requestedDate: { type: Date },
        requestedStartTime: { type: String, trim: true }, // "HH:mm"
        requestedEndTime: { type: String, trim: true }, // "HH:mm"

        reason: { type: String, default: "", trim: true, maxlength: 1000 },

        // Snapshot of the job's own schedule at request time — not load-
        // bearing for approval (that always re-reads the live Job), purely
        // so a staff reviewer and the client's own pending-request banner
        // can show "Fri 17 Oct → Sat 18 Oct" without a second lookup, and
        // stays meaningful even if the job changes again later.
        originalDate: { type: Date, required: true },
        originalStartTime: { type: String, required: true },
        originalEndTime: { type: String, required: true },

        status: {
            type: String,
            enum: ["pending", "approved", "declined", "cancelled"],
            default: "pending",
            index: true,
        },
        reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
        reviewedAt: Date,
        reviewNotes: { type: String, default: "", trim: true, maxlength: 500 },

        isDeleted: { type: Boolean, default: false },
    },
    { timestamps: true }
);

JobChangeRequestSchema.index({ company: 1, status: 1, createdAt: -1 });
JobChangeRequestSchema.index({ client: 1, status: 1, createdAt: -1 });
JobChangeRequestSchema.index({ job: 1, status: 1 });

export default mongoose.model("JobChangeRequest", JobChangeRequestSchema);
