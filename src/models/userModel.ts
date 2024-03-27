import mongoose from "mongoose";
import { USER_ROLES } from "../utils/constant.js";
import { IUser } from "../interfaces/models/user.js";
import { string } from "zod";
import { generateUniqueCharacter } from "../utils/generateRandomNumbers.js";
export interface IUserModel extends mongoose.Document, IUser {
  getDefaultResultOrder(): void;
}

const UserSchema = new mongoose.Schema<IUserModel>({
  name: {
    required: [true, "please "],
    type: String,
  },
  email: String,
  userId: Number,
  password: String,
  role: {
    type: String,
    enum: Object.values(USER_ROLES),
    default: USER_ROLES.user,
  },
  avatar: String,
  avatarPublicId: String,
  isVerified: {
    type: Boolean,
    enum: [true, false],
    default: "false",
  },
});

UserSchema.methods.toJSON = function () {
  let obj = this.toObject();
  delete obj.password;
  return obj;
};
// UserSchema.pre("validate",async function(){

//   this.userId=await generateUniqueCharacter({Model:this,type:"number"})
// })
export default mongoose.model("User", UserSchema);
