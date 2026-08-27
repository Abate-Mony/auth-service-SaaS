import mongoose, { InferSchemaType, Schema } from "mongoose";
import { IUser } from "../interfaces/models/user.js";
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
        // Admins might not have it strictly on step 1 of registration, 
        // but it should be attached immediately after the company is created.
        return this.role !== "admin";
      },
    },

    password: {
      type: String,
      required: true,
      select: false,
    },

    role: {
      type: String,
      enum: ["admin", "manager", "worker"],
      default: "worker",
    },
    phone: { type: String, trim: true, default: "0000-0000-0000" },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: function (this: any) { return this.role !== "admin" },
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
