import mongoose from "mongoose";
import { InferSchemaType } from "mongoose";
import { Schema } from "mongoose";

export const ChannelPreferenceSchema = new Schema(
    {
        email: {
            type: Boolean,
            default: false,
        },

        push: {
            type: Boolean,
            default: true,
        },

        inApp: {
            type: Boolean,
            default: true,
        },
    },
    {
        _id: false,
    }
);
// export type ChannelPreference = InferSchemaType<typeof ChannelPreferenceSchema>;
// export default mongoose.model("ChannelPreference", ChannelPreferenceSchema);