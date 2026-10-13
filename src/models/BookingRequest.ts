import mongoose, { Schema } from "mongoose";

// Same shape/conventions as TimeOffRequest.ts — a client-portal user
// submits a request, staff reviews it. The one real difference: approving
// doesn't just flip a status field here, it creates a real Job (via
// CreateJob.tsx's ?bookingRequest=<id> prefill flow, see jobController.ts's
// createJob) — so there's no approveBookingRequest handler, only decline.
const BookingRequestSchema = new Schema(
    {
        company: { type: Schema.Types.ObjectId, ref: "Company", required: true },
        client: { type: Schema.Types.ObjectId, ref: "Client", required: true },
        // The portal User who submitted this — not the Client itself, since
        // a Client can have several portal users (see clientRole).
        requestedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },

        service: { type: String, required: true, trim: true, maxlength: 200 },
        preferredDate: { type: Date, required: true },
        preferredTime: { type: String, trim: true }, // "HH:mm", optional
        notes: { type: String, default: "", trim: true, maxlength: 1000 },

        status: {
            type: String,
            enum: ["pending", "approved", "declined", "cancelled"],
            default: "pending",
            index: true,
        },
        reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
        reviewedAt: Date,
        reviewNotes: { type: String, default: "", trim: true, maxlength: 500 },
        // Set only once approved — the Job created from this request, via
        // createJob's bookingRequestId side effect.
        convertedJob: { type: Schema.Types.ObjectId, ref: "Job", default: null },

        isDeleted: { type: Boolean, default: false },
    },
    { timestamps: true }
);

BookingRequestSchema.index({ company: 1, status: 1, createdAt: -1 });
BookingRequestSchema.index({ client: 1, status: 1, createdAt: -1 });

export default mongoose.model("BookingRequest", BookingRequestSchema);
