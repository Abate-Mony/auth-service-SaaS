import mongoose, { InferSchemaType, Schema } from "mongoose";
import { BUSINESS_TYPES, COMPANY_SIZES } from "../utils/constant.js";
import { ICompany } from "../interface/model/company.js";

export interface ICompanyModel extends mongoose.Document, ICompany {}

const CompanySchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    businessType: {
      type: String,
      enum: BUSINESS_TYPES,
      required: true,
    },
    size: {
      type: String,
      enum: COMPANY_SIZES,
      required: true,
    },
    website: {
      type: String,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    country: {
      type: String,
      trim: true,
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

export type Company = InferSchemaType<typeof CompanySchema>;
export default mongoose.model("Company", CompanySchema);