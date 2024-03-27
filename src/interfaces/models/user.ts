import { Schema } from "mongoose";
import { USER_ROLES } from "../../utils/constant.js";
type CreatedBy = {
  userId: typeof Schema.ObjectId;
  user: string;
};
type Role = (typeof USER_ROLES)[number];
export interface IUser {
  name: string;
  password: string;
  isVerified: any;
  createdBy: CreatedBy;
  avatarPublicId?: string;
  avatar?: string;
  role: Role;
  email: string;
  sex: string;
  userId: number;
}
