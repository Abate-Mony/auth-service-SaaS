import mongoose, { InferSchemaType, Schema } from "mongoose";

const JobAssignmentSchema = new Schema(
    {
        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true,
        },
        fullname: {
            type: String,
            required: true,
        },
        job: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Job",
            required: true,
        },

        worker: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },

        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },

        status: {
            type: String,
            enum: [
                "pending",
                "accepted",
                "declined",
                "in-progress",
                "completed",
                "cancelled",
            ],
            default: "pending",
        },

        acceptedAt: {
            type: Date,
        },

        declinedAt: {
            type: Date,
        },

        checkedInAt: {
            type: Date,
        },

        checkedOutAt: {
            type: Date,
        },

        completedAt: {
            type: Date,
        },

        cancellationReason: {
            type: String,
            default: "",
        },

        workerNotes: {
            type: String,
            default: "",
        },

        managerNotes: {
            type: String,
            default: "",
        },

        hoursWorked: {
            type: Number,
            default: 0,
        },

        overtimeHours: {
            type: Number,
            default: 0,
        },

        payRate: {
            type: Number,
            default: 0,
        },

        totalPay: {
            type: Number,
            default: 0,
        },
    },
    {
        timestamps: true,
    }
);

/**
 * Prevent assigning the same worker twice
 * to the same job.
 */
JobAssignmentSchema.index(
    {
        job: 1,
        worker: 1,
    },
    {
        unique: true,
    }
);

export type JobAssignment = InferSchemaType<
    typeof JobAssignmentSchema
>;

export default mongoose.model(
    "JobAssignment",
    JobAssignmentSchema
);