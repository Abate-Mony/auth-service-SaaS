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
    // company: {
    //   type: mongoose.Schema.Types.ObjectId,
    //   ref: "Company",
    //   required: function (this: any) {
    //     return this.role === "admin"; // only company creators/admins are required to have one on creation
    //   },
    // },


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
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: function (this: any) {
        return this.role === "worker";
      },
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
