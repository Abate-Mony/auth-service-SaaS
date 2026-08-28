import mongoose, { InferSchemaType, Schema } from "mongoose";
import { BUSINESS_TYPES, COMPANY_SIZES, PLAN_LIMITS } from "../utils/constant.js";
import { ICompany } from "../interface/model/company.js";

export interface ICompanyModel extends mongoose.Document, ICompany { }

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
    plan: {
      type: String,
      enum: ["free", "starter", "professional", "enterprise"],
      default: "free",
      index: true,
    },
    maxWorkers: {
      type: Number,
      default: PLAN_LIMITS.free,
    },

    // ── Time & attendance ──────────────────────────────────────────────
    clockInGraceMinutes: { type: Number, default: 30 },
    lateThresholdMinutes: { type: Number, default: 10 },
    autoClockOutEnabled: { type: Boolean, default: true },
    // How many hours past a shift's scheduled end an "in-progress"
    // assignment with no clock-out is force-closed by the cron.
    autoClockOutAfterHours: { type: Number, default: 2 },
    // How many minutes past scheduled end a worker's own clock-out can run
    // before the extra time needs a manager's approval.
    lateClockOutThresholdMinutes: { type: Number, default: 15 },
    payFromScheduledStart: { type: Boolean, default: false },

    // ── Location ────────────────────────────────────────────────────────
    geofenceMode: { type: String, enum: ["off", "warn", "enforce"], default: "warn" },
    defaultGeofenceRadiusMeters: { type: Number, default: 150 },

    // ── Breaks ──────────────────────────────────────────────────────────
    breaksArePaid: { type: Boolean, default: false },
    autoDeductBreakMinutes: { type: Number, default: 0 }, // 0 = off
    autoDeductAfterMinutes: { type: Number, default: 360 },

    // ── Pay ─────────────────────────────────────────────────────────────
    overtimeThresholdMinutes: { type: Number, default: 480 },
    overtimeMultiplier: { type: Number, default: 1.5 },
    weeklyHoursTarget: { type: Number, default: 0 },
    currency: { type: String, enum: ["GBP", "USD", "EUR"], default: "GBP" },
    defaultPayRate: { type: Number, default: 0 },

    // ── Scheduling ──────────────────────────────────────────────────────
    timezone: { type: String, default: "Europe/London" },
    weekStartsOn: { type: String, enum: ["monday", "sunday"], default: "monday" },
    generateAheadDays: { type: Number, default: 30 },
    openShiftsEnabled: { type: Boolean, default: false },
    openShiftsRequireApproval: { type: Boolean, default: true },
  },
  {
    timestamps: true,
  }
);

export type Company = InferSchemaType<typeof CompanySchema>;
export default mongoose.model("Company", CompanySchema);