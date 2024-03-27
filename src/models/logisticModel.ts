import mongoose from "mongoose";
import { PRODUCT_STATES } from "../utils/constant.js";
import { ILogistic } from "../interfaces/models/product.js";
export interface ILogisticModel extends mongoose.Document, ILogistic {}
const LogisticSchema = new mongoose.Schema<ILogisticModel>({
  name: String,
  price: Number,
  tracking_number: String,
  status: {
    type: String,
    enum: [...Object.values(PRODUCT_STATES)],
    default: "pending",
  },
  createdBy: {
    // userId: mongoose.Types.ObjectId,
    userId: Number,
    user: String,
  },
  descriptions: [
    {
      name: String,
      imgUrl: String,
      avatarPublicId: String,
      
    },
  ],
});

export default mongoose.model("Logistic", LogisticSchema);
