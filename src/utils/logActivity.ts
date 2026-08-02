// utils/logActivity.ts
import mongoose from "mongoose";
import ActivityLog, { ACTIVITY_TYPES } from "../models/ActivityLog.js";
// import ActivityLog from "../models/ActivityLog.js";

export async function logActivity(params: {
  job: mongoose.Types.ObjectId | string;
  type: (typeof ACTIVITY_TYPES)[number];
  actor?: mongoose.Types.ObjectId | string;
  assignment?: mongoose.Types.ObjectId | string;
  workers?: (mongoose.Types.ObjectId | string)[];
  metadata?: Record<string, any>;
}) {
  await ActivityLog.create(params);
}