// utils/planLimits.ts
//
// Single source of truth for "is this company allowed to do X on its
// current plan" — every enforcement point (creating a worker, creating a
// job, turning on a gated feature) goes through here instead of
// re-implementing the free/starter/professional/enterprise split locally,
// so a tier's limits can't drift between where they're defined
// (PLAN_LIMITS) and where they're actually checked.
import { BadRequestError } from "../errors/customErrors.js";
import Company from "../models/company.js";
import UserModel from "../models/userModel.js";
import Job from "../models/jobModel.js";
import { PLAN_LIMITS, type Plan, type PlanFeatures } from "./constant.js";
import dayjs from "./dayjsSetup.js";

type CompanyForLimits = { plan: Plan; maxWorkers?: number | null };

// A company's own `maxWorkers` is a rare per-company override (negotiated
// Enterprise deals) — everyone else falls back to their plan's standard cap.
export const getEffectiveMaxWorkers = (company: CompanyForLimits): number =>
  company.maxWorkers ?? PLAN_LIMITS[company.plan].maxWorkers;

const loadCompanyOrThrow = async (companyId: unknown) => {
  const company = await Company.findById(companyId).select("plan maxWorkers");
  if (!company) throw new BadRequestError("Company not found.");
  return company;
};

// Call before creating a worker account. Managers/admins don't count against
// this — it's specifically the workforce the plan is priced on.
export const assertCanAddWorker = async (companyId: unknown): Promise<void> => {
  const company = await loadCompanyOrThrow(companyId);
  const limit = getEffectiveMaxWorkers(company);
  if (limit === -1) return;

  const count = await UserModel.countDocuments({ company: companyId, role: "worker", isActive: true });
  if (count >= limit) {
    throw new BadRequestError(
      `Your ${company.plan} plan allows up to ${limit} worker${limit === 1 ? "" : "s"}. Upgrade your plan to add more.`
    );
  }
};

// Call before creating a job (including a recurring series' template — the
// occurrences it generates aren't individually re-checked, so this is a
// soft gate against runaway recurring schedules, not a precise per-job count).
export const assertCanCreateJob = async (companyId: unknown): Promise<void> => {
  const company = await loadCompanyOrThrow(companyId);
  const limit = PLAN_LIMITS[company.plan].maxJobsPerMonth;
  if (limit === -1) return;

  const startOfMonth = dayjs().startOf("month").toDate();
  // Job.company is schema-typed String (a pre-existing quirk elsewhere in
  // this codebase), unlike Company's own _id.
  const count = await Job.countDocuments({
    company: companyId.toString(),
    isDeleted: false,
    isTemplate: false,
    // A draft was never actually scheduled work — it doesn't count against
    // the cap until it's published, same "not real yet" treatment drafts
    // get everywhere else in this codebase.
    status: { $ne: "draft" },
    createdAt: { $gte: startOfMonth },
  });
  if (count >= limit) {
    throw new BadRequestError(
      `Your ${company.plan} plan allows up to ${limit} jobs per month. Upgrade your plan to create more.`
    );
  }
};

// Call before turning on / using a gated feature (recurring jobs, open
// shifts, GPS verification, advanced reports). `plan` is passed in directly
// wherever the caller already has the company loaded, to avoid a redundant
// fetch — use assertFeatureEnabledForCompany below when it doesn't.
export const assertFeatureEnabled = (plan: Plan, feature: keyof PlanFeatures): void => {
  if (!PLAN_LIMITS[plan].features[feature]) {
    throw new BadRequestError(`This feature isn't available on your ${plan} plan. Upgrade to use it.`);
  }
};

export const assertFeatureEnabledForCompany = async (companyId: unknown, feature: keyof PlanFeatures): Promise<void> => {
  const company = await loadCompanyOrThrow(companyId);
  assertFeatureEnabled(company.plan, feature);
};
