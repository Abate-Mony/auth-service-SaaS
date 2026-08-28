// models/notificationPreferenceModel.ts

import mongoose, { Schema } from "mongoose";
import { ChannelPreferenceSchema } from "./ChannelPreferenceModel.js";

export interface ChannelPreference {
    email: boolean;
    push: boolean;
    inApp: boolean;
}

// Hand-written rather than inferred: the same ChannelPreferenceSchema
// instance is reused across 11 sibling `events.*` fields below, which
// sends Mongoose 9's automatic type inference into a circular reference
// ("Type of property 'events' circularly references itself").
export interface NotificationPreferenceDoc {
    user: mongoose.Types.ObjectId;
    company: mongoose.Types.ObjectId;
    emailEnabled: boolean;
    pushEnabled: boolean;
    inAppEnabled: boolean;
    events: {
        job_assigned: ChannelPreference;
        job_accepted: ChannelPreference;
        job_declined: ChannelPreference;
        worker_checked_in: ChannelPreference;
        worker_late: ChannelPreference;
        worker_checked_out: ChannelPreference;
        job_completed: ChannelPreference;
        geofence_warning: ChannelPreference;
        timesheet_submitted: ChannelPreference;
        timesheet_approved: ChannelPreference;
        timesheet_rejected: ChannelPreference;
    };
}

const NotificationPreferenceSchema = new Schema<NotificationPreferenceDoc>(
    {
        user: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
            unique: true,
            index: true,
        },

        company: {
            type: Schema.Types.ObjectId,
            ref: "Company",
            required: true,
            index: true,
        },

        // Master switches
        emailEnabled: {
            type: Boolean,
            default: true,
        },

        pushEnabled: {
            type: Boolean,
            default: true,
        },

        inAppEnabled: {
            type: Boolean,
            default: true,
        },

        events: {
            job_assigned: {
                type: ChannelPreferenceSchema,
                default: () => ({
                    email: true,
                    push: true,
                    inApp: true,
                }),
            },

            job_accepted: {
                type: ChannelPreferenceSchema,
                default: () => ({
                    email: false,
                    push: true,
                    inApp: true,
                }),
            },

            job_declined: {
                type: ChannelPreferenceSchema,
                default: () => ({
                    email: true,
                    push: true,
                    inApp: true,
                }),
            },

            worker_checked_in: {
                type: ChannelPreferenceSchema,
                default: () => ({
                    email: false,
                    push: false,
                    inApp: true,
                }),
            },

            worker_late: {
                type: ChannelPreferenceSchema,
                default: () => ({
                    email: true,
                    push: true,
                    inApp: true,
                }),
            },

            worker_checked_out: {
                type: ChannelPreferenceSchema,
                default: () => ({
                    email: false,
                    push: false,
                    inApp: true,
                }),
            },

            job_completed: {
                type: ChannelPreferenceSchema,
                default: () => ({
                    email: false,
                    push: true,
                    inApp: true,
                }),
            },

            geofence_warning: {
                type: ChannelPreferenceSchema,
                default: () => ({
                    email: true,
                    push: true,
                    inApp: true,
                }),
            },

            timesheet_submitted: {
                type: ChannelPreferenceSchema,
                default: () => ({
                    email: false,
                    push: true,
                    inApp: true,
                }),
            },

            timesheet_approved: {
                type: ChannelPreferenceSchema,
                default: () => ({
                    email: true,
                    push: true,
                    inApp: true,
                }),
            },

            timesheet_rejected: {
                type: ChannelPreferenceSchema,
                default: () => ({
                    email: true,
                    push: true,
                    inApp: true,
                }),
            },
        },
    },
    {
        timestamps: true,
    }
);

export type NotificationPreference = NotificationPreferenceDoc;

export default mongoose.model(
    "NotificationPreference",
    NotificationPreferenceSchema
);