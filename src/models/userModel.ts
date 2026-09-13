import mongoose, { InferSchemaType, Schema } from "mongoose";
import { IUser } from "../interfaces/models/user.js";
import { FileRefSchema } from "./shared/fileRefSchema.js";
export interface IUserModel extends mongoose.Document, IUser {
  getDefaultResultOrder(): void;
}


const UserSchema = new Schema(
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
    company: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      required: function (this: any) {
        // Required for managers and workers.
        // Owners and admins might not have it strictly on step 1 of
        // registration (an owner IS the one creating the company), but it
        // should be attached immediately after the company is created.
        return this.role !== "admin" && this.role !== "owner";
      },
    },

    password: {
      type: String,
      required: true,
      select: false,
    },

    role: {
      type: String,
      enum: ["owner", "admin", "manager", "worker"],
      default: "worker",
    },
    phone: { type: String, trim: true, default: "0000-0000-0000" },
    gender: {
      type: String,
      enum: ["Male", "Female", "Other", "Prefer not to say"],
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: function (this: any) { return this.role !== "admin" && this.role !== "owner" },
    },
    isVerified: {
      type: Boolean,
      default: false,
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    lastLogin: Date,

    refreshToken: {
      type: String,
      select: false,
    },
    refreshTokenExpiresAt: {
      type: Date,
      select: false,
    },

    emailVerificationToken: {
      type: String,
      select: false,
    },
    emailVerificationExpiresAt: {
      type: Date,
      select: false,
    },

    passwordResetToken: {
      type: String,
      select: false,
    },
    passwordResetExpiresAt: {
      type: Date,
      select: false,
    },

    // One entry per subscribed device/browser — a worker can have several.
    pushSubscriptions: {
      type: [
        {
          endpoint: { type: String, required: true },
          keys: {
            p256dh: { type: String, required: true },
            auth: { type: String, required: true },
          },
        },
      ],
      default: [],
    },

    // Expo push tokens, one per mobile device the worker is logged in on.
    expoPushTokens: {
      type: [String],
      default: [],
    },

    // Any role can set their own — a personal account setting, not
    // restricted to workers.
    profilePhoto: { type: FileRefSchema, default: null },

    // Documents a worker uploads about themselves (ID, right-to-work,
    // certifications, etc.) — self-service, viewable by the worker and by
    // admins/managers in the same company. resourceType is Cloudinary's own
    // classification (image vs raw), stored at upload time so a later
    // delete uses the exact value Cloudinary expects instead of guessing.
    documents: {
      type: [
        {
          name: { type: String, required: true, trim: true },
          url: { type: String, required: true },
          publicId: { type: String, required: true },
          resourceType: { type: String, enum: ["image", "raw"], required: true },
          mimeType: { type: String },
          uploadedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);



UserSchema.methods.toJSON = function () {
  let obj = this.toObject();
  delete obj.password;
  return obj;
};
// UserSchema.pre("validate",async function(){

export type User = InferSchemaType<typeof UserSchema>;
export default mongoose.model("User", UserSchema);
