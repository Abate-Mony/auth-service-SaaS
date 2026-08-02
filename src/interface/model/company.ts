import mongoose from "mongoose";

export interface ICompany {
  name: string;
  businessType: string;
  size: string;
  website?: string;
  phone?: string;
  country?: string;
  owner: mongoose.Types.ObjectId;
  isActive: boolean;
}