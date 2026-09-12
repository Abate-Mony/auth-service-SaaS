import { JobStatusNotificationType } from "./types.js";

export type productStatesType = "pending" | "recieve" | "sent";
export type UserroleTypes = "admin" | "user" | "moderator" | "worker";
interface IUserTypes {
  [key: string | number]: UserroleTypes;
}
interface IProductStates {
  [key: string | number]: productStatesType;
}
export const USER_ROLES: IUserTypes = {
  admin: "admin",
  user: "worker",
  moderator: "moderator",
  worker: "worker",
};
export const PRODUCT_STATES :IProductStates = {
  pending: "pending",
  recieve:"recieve",
  sent:"sent"
};
export const BUSINESS_TYPES = [
  "Cleaning Company", "Security Company", "Care Agency", "Construction",
  "Hospitality", "Warehouse", "Logistics", "Healthcare", "Retail",
  "Manufacturing", "Education", "Other",
] as const;

export const COMPANY_SIZES = [
  "1–10 workers", "11–25 workers", "26–50 workers",
  "51–100 workers", "100+",
] as const;
export const PLANS = ["free", "starter", "professional", "enterprise"] as const;
export type Plan = (typeof PLANS)[number];

// Features that are locked below a certain plan — checked via
// utils/planLimits.ts's assertFeatureEnabled, never inferred ad hoc at the
// call site, so a feature's tier can't drift between where it's gated and
// where it's advertised (pricing page, upgrade prompts).
export interface PlanFeatures {
  gpsVerification: boolean;
  recurringJobs: boolean;
  openShifts: boolean;
  advancedReports: boolean;
}

export interface PlanDefinition {
  // -1 means unlimited.
  maxWorkers: number;
  maxJobsPerMonth: number;
  features: PlanFeatures;
}

export const PLAN_LIMITS: Record<Plan, PlanDefinition> = {
  free: {
    maxWorkers: 3,
    maxJobsPerMonth: 10,
    features: { gpsVerification: false, recurringJobs: false, openShifts: false, advancedReports: false },
  },
  starter: {
    maxWorkers: 15,
    maxJobsPerMonth: 100,
    features: { gpsVerification: true, recurringJobs: false, openShifts: false, advancedReports: false },
  },
  professional: {
    maxWorkers: 50,
    maxJobsPerMonth: -1,
    features: { gpsVerification: true, recurringJobs: true, openShifts: true, advancedReports: true },
  },
  enterprise: {
    maxWorkers: -1,
    maxJobsPerMonth: -1,
    features: { gpsVerification: true, recurringJobs: true, openShifts: true, advancedReports: true },
  },
};

// Display label for each gated feature — the ONLY place this wording is
// written, so the pricing page and any "upgrade to unlock" prompt always
// describe a feature the same way.
export const PLAN_FEATURE_LABELS: Record<keyof PlanFeatures, string> = {
  gpsVerification: "GPS clock-in verification",
  recurringJobs: "Recurring job templates",
  openShifts: "Open shifts & approval workflows",
  advancedReports: "Advanced reports & analytics",
};

// Marketing/pricing-page copy for a plan — deliberately NOT where the
// worker/job counts or feature list live (that's PLAN_LIMITS, the
// enforcement source of truth). GET /companies/plans composes the two
// together, so the numbers a manager sees on the pricing page can never
// drift from what's actually enforced — a real bug this app already hit
// once with a hand-maintained frontend copy of these same numbers.
export interface PlanCatalogEntry {
  name: string;
  tagline: string;
  monthlyPrice: number | null; // null = custom/contact sales
  annualPrice: number | null;
  annualMonthly: number | null;
  ctaLabel: string;
  highlighted: boolean;
  // Perks this app doesn't gate on (yet) — CSV export, support tier, etc.
  // Layered on top of the PLAN_LIMITS-derived bullets, never replacing them.
  extraFeatures: string[];
}

export const PLAN_CATALOG: Record<Plan, PlanCatalogEntry> = {
  free: {
    name: "Free",
    tagline: "For trying things out",
    monthlyPrice: 0,
    annualPrice: 0,
    annualMonthly: 0,
    ctaLabel: "Continue free",
    highlighted: false,
    extraFeatures: ["Clock-in / clock-out", "Basic timesheets", "Email support"],
  },
  starter: {
    name: "Starter",
    tagline: "For small teams",
    monthlyPrice: 29,
    annualPrice: 276,
    annualMonthly: 23,
    ctaLabel: "Upgrade to Starter",
    highlighted: false,
    extraFeatures: ["Basic timesheets", "CSV export", "Email support"],
  },
  professional: {
    name: "Professional",
    tagline: "For operational teams",
    monthlyPrice: 79,
    annualPrice: 756,
    annualMonthly: 63,
    ctaLabel: "Upgrade to Professional",
    highlighted: true,
    extraFeatures: ["Priority support"],
  },
  enterprise: {
    name: "Enterprise",
    tagline: "For large organisations",
    monthlyPrice: null,
    annualPrice: null,
    annualMonthly: null,
    ctaLabel: "Contact sales",
    highlighted: false,
    extraFeatures: ["Multi-site management", "Dedicated account manager", "Custom integrations", "SLA guarantee"],
  },
};
// lettinge
/**
 * Only events that require admin attention should generate email.
 *
 * Routine events such as:
 * - accepted
 * - normal check-in
 * - completed
 *
 * should normally remain in-app notifications.
 */
export const EMAIL_WORTHY_EVENTS = new Set<JobStatusNotificationType>([
  "reject-job",
  "cancel-job",
  "late-start",
  "geofence-warning",
  "overtime-review",
]);
  export const NOTIFICATION_EVENTS = [
      "job_assigned",
      "job_accepted",
      "job_declined",
  
      "worker_checked_in",
      "worker_late",
      "worker_checked_out",
  
      "job_completed",
  
      "geofence_warning",
  
      "timesheet_submitted",
      "timesheet_approved",
      "timesheet_rejected",
  ] as const;
  export const NOTIFICATION_CHANNELS = [
      "email",
      "push",
      "inApp",
  ] as const;