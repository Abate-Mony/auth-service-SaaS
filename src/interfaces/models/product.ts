import mongoose from "mongoose";
import { productStatesType } from "../../utils/constant.js";
export interface ILogistic {
  name: string;
  price: string;
  tracking_number: string;
  descriptions: {
    name?: string;
    imgUrl: string;
    avatarPublicId?: string
  }[];
  status: productStatesType;
  createdBy: {
    // userId: typeof mongoose.Types.ObjectId;
    userId: number;
    user: string;
  };
}
