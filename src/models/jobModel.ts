import mongoose from "mongoose";

const JobSchema = new mongoose.Schema(
    {
        // company: {
        //   type: mongoose.Schema.Types.ObjectId,
        //   ref: "Company",
        //   required: true,
        //   index: true,
        // },

        description: {
            type: String,
            required: true,
            trim: true,
        },
        title: {
            type: String,
            required: true,
            trim: true,
        },

        company: {
            type: String,
            required: true,
            trim: true,
        },

        client: {
            type: String,
            trim: true,
            default: "",
        },

        location: {
            type: String,
            required: true,
        },

        address: {
            type: String,
            default: "",
        },

        date: {
            type: Date,
            required: true,
        },

        startTime: {
            type: String,
            required: true,
        },

        endTime: {
            type: String,
            required: true,
        },

        hours: {
            type: String,
            required: true,
        },

        workers: [
            {
                user: {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: "User",
                },
                fullname: String,
                email: String,
                phone: String,
            }
        ],

        // supervisor: {
        //     user: {
        //         type: mongoose.Schema.Types.ObjectId,
        //         ref: "User",
        //     },
        //     fullname: String,
        //     email: String,
        //     phone: String,
        // },

        requiredWorkers: {
            type: Number,
            default: 1,
        },

        // filledWorkers: {
        //     type: Number,
        //     default: 0,
        // },

        // payRate: {
        //     type: Number,
        //     default: 0,
        // },

        // chargeRate: {
        //     type: Number,
        //     default: 0,
        // },

        status: {
            type: String,
            enum: [
                "draft",
                "published",
                "assigned",
                "in-progress",
                "completed",
                "cancelled",
            ],
            default: "draft",
        },

        // priority: {
        //     type: String,
        //     enum: ["low", "medium", "high", "urgent"],
        //     default: "medium",
        // },

        notes: {
            type: String,
            default: "",
        },

        instructions: {
            type: String,
            default: "",
        },

        recurrence: {
            type: String,
            enum: ["none", "daily", "weekly", "monthly"],
            default: "none",
        },

        isPublished: {
            type: Boolean,
            default: false,
        },

        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
        },
    },
    {
        timestamps: true,
    }
);

export default mongoose.model("Job", JobSchema);