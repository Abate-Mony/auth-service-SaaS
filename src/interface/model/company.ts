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
  plan?: "free" | "starter" | "professional" | "enterprise";
  maxWorkers?: number;

  // Time & attendance
  clockInGraceMinutes?: number;
  lateThresholdMinutes?: number;
  autoClockOutEnabled?: boolean;
  autoClockOutAfterHours?: number;
  lateClockOutThresholdMinutes?: number;
  payFromScheduledStart?: boolean;

  // Location
  geofenceMode?: "off" | "warn" | "enforce";
  defaultGeofenceRadiusMeters?: number;

  // Breaks
  breaksArePaid?: boolean;
  autoDeductBreakMinutes?: number;
  autoDeductAfterMinutes?: number;

  // Pay
  overtimeThresholdMinutes?: number;
  overtimeMultiplier?: number;
  weeklyHoursTarget?: number;
  currency?: "GBP" | "USD" | "EUR";
  defaultPayRate?: number;

  // Scheduling
  timezone?: string;
  weekStartsOn?: "monday" | "sunday";
  generateAheadDays?: number;
  openShiftsEnabled?: boolean;
  openShiftsRequireApproval?: boolean;
}
