import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { getReqUser, MiddlewareFn } from "../interfaces/expresstype.js";
import Company from "../models/company.js";
import { assertFeatureEnabledForCompany } from "../utils/planLimits.js";
import { PLANS, PLAN_LIMITS, PLAN_CATALOG, PLAN_FEATURE_LABELS, type PlanFeatures } from "../utils/constant.js";

// Kept in one place so GET and PATCH always agree on exactly which fields
// count as "settings" (as opposed to company profile fields like name/owner).
const COMPANY_SETTINGS_FIELDS = [
    "clockInGraceMinutes",
    "lateThresholdMinutes",
    "autoClockOutEnabled",
    "autoClockOutAfterHours",
    "lateClockOutThresholdMinutes",
    "payFromScheduledStart",

    "geofenceMode",
    "defaultGeofenceRadiusMeters",

    "breaksArePaid",
    "autoDeductBreakMinutes",
    "autoDeductAfterMinutes",

    "overtimeThresholdMinutes",
    "overtimeMultiplier",
    "weeklyHoursTarget",
    "currency",
    "defaultPayRate",

    "timezone",
    "weekStartsOn",
    "generateAheadDays",
    "openShiftsEnabled",
    "openShiftsRequireApproval",
] as const;

// Intl throws RangeError for anything that isn't a recognised IANA zone —
// there's no dedicated validator on the platform, so this is the standard way.
const isValidTimezone = (tz: string): boolean => {
    try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
        return true;
    } catch {
        return false;
    }
};

const companySettingsSchema = z
    .object({
        clockInGraceMinutes: z.number().int().min(0),
        lateThresholdMinutes: z.number().int().min(0),
        autoClockOutEnabled: z.boolean(),
        autoClockOutAfterHours: z.number().min(0).max(24),
        lateClockOutThresholdMinutes: z.number().int().min(0).max(240),
        payFromScheduledStart: z.boolean(),

        geofenceMode: z.enum(["off", "warn", "enforce"]),
        defaultGeofenceRadiusMeters: z.number().int().min(25).max(5000),

        breaksArePaid: z.boolean(),
        autoDeductBreakMinutes: z.number().int().min(0),
        autoDeductAfterMinutes: z.number().int().min(0),

        overtimeThresholdMinutes: z.number().int().min(0),
        overtimeMultiplier: z.number().min(1),
        weeklyHoursTarget: z.number().int().min(0),
        currency: z.enum(["GBP", "USD", "EUR"]),
        defaultPayRate: z.number().min(0),

        timezone: z.string().refine(isValidTimezone, { message: "Unrecognised IANA timezone" }),
        weekStartsOn: z.enum(["monday", "sunday"]),
        generateAheadDays: z.number().int().min(1).max(365),
        openShiftsEnabled: z.boolean(),
        openShiftsRequireApproval: z.boolean(),
    })
    .partial() // PATCH — every field optional, unknown keys rejected below
    .strict();

export const getCompanySettings: MiddlewareFn = async (req, res) => {
    const company = await Company.findById(getReqUser(req).company_id)
        .select(COMPANY_SETTINGS_FIELDS.join(" "))
        .lean();

    if (!company) throw new NotFoundError("Company not found.");

    res.status(StatusCodes.OK).json({ success: true, settings: company });
};

export const updateCompanySettings: MiddlewareFn = async (req, res) => {
    let settings: z.infer<typeof companySettingsSchema>;
    try {
        settings = companySettingsSchema.parse(req.body);
    } catch (err) {
        if (err instanceof z.ZodError) {
            const message = err.issues
                .map(issue => `${issue.path.join(".") || "value"}: ${issue.message}`)
                .join("; ");
            throw new BadRequestError(message);
        }
        throw err;
    }

    if (Object.keys(settings).length === 0) {
        throw new BadRequestError("No valid settings fields provided.");
    }

    const companyId = getReqUser(req).company_id;
    if (settings.geofenceMode !== undefined && settings.geofenceMode !== "off") {
        await assertFeatureEnabledForCompany(companyId, "gpsVerification");
    }
    if (settings.openShiftsEnabled === true) {
        await assertFeatureEnabledForCompany(companyId, "openShifts");
    }

    // settings is Zod-validated and only contains allowlisted keys — never
    // spread req.body directly into the model.
    const company = await Company.findByIdAndUpdate(
        companyId,
        { $set: settings },
        { new: true, runValidators: true }
    ).select(COMPANY_SETTINGS_FIELDS.join(" "));

    if (!company) throw new NotFoundError("Company not found.");

    res.status(StatusCodes.OK).json({ success: true, settings: company });
};

// ─────────────────────────────────────────────────────────────
// Plan
// ─────────────────────────────────────────────────────────────
// No payment processing behind this yet — changing plan is just setting the
// field. Real billing (Stripe or similar, actually charging on upgrade) is
// a separate, larger piece of work; this only makes the plan itself real
// enough that its limits (see planLimits.ts) mean something.

const planSchema = z.object({ plan: z.enum(PLANS) }).strict();

// GET /companies/plans — the full pricing-page catalog for all four tiers.
// Every number and feature bullet here is composed from PLAN_LIMITS, never
// hand-typed — the pricing page and the actual enforcement can't disagree.
export const getPlanCatalog: MiddlewareFn = async (_req, res) => {
    const catalog = PLANS.map(id => {
        const limits = PLAN_LIMITS[id];
        const meta = PLAN_CATALOG[id];
        const featureKeys = Object.keys(limits.features) as (keyof PlanFeatures)[];

        const features = [
            limits.maxWorkers === -1 ? "Unlimited workers" : `Up to ${limits.maxWorkers} workers`,
            limits.maxJobsPerMonth === -1 ? "Unlimited jobs" : `Up to ${limits.maxJobsPerMonth} jobs per month`,
            ...featureKeys.filter(key => limits.features[key]).map(key => PLAN_FEATURE_LABELS[key]),
            ...meta.extraFeatures,
        ];
        const notIncluded = featureKeys.filter(key => !limits.features[key]).map(key => PLAN_FEATURE_LABELS[key]);

        return {
            id,
            name: meta.name,
            tagline: meta.tagline,
            monthlyPrice: meta.monthlyPrice,
            annualPrice: meta.annualPrice,
            annualMonthly: meta.annualMonthly,
            ctaLabel: meta.ctaLabel,
            highlighted: meta.highlighted,
            features,
            notIncluded: notIncluded.length ? notIncluded : undefined,
        };
    });

    res.status(StatusCodes.OK).json({ success: true, plans: catalog });
};

export const getCompanyPlan: MiddlewareFn = async (req, res) => {
    const company = await Company.findById(getReqUser(req).company_id).select("plan maxWorkers").lean();
    if (!company) throw new NotFoundError("Company not found.");

    const plan = company.plan as keyof typeof PLAN_LIMITS;
    res.status(StatusCodes.OK).json({
        success: true,
        plan,
        maxWorkers: company.maxWorkers ?? PLAN_LIMITS[plan].maxWorkers,
        limits: PLAN_LIMITS[plan],
    });
};

export const updateCompanyPlan: MiddlewareFn = async (req, res) => {
    let data: z.infer<typeof planSchema>;
    try {
        data = planSchema.parse(req.body);
    } catch (err) {
        if (err instanceof z.ZodError) {
            throw new BadRequestError(err.issues.map(i => `${i.path.join(".") || "value"}: ${i.message}`).join("; "));
        }
        throw err;
    }

    // Downgrading below the current worker count is allowed here — there's
    // no payment step to gate it on yet, so the only real consequence is
    // that no NEW worker can be added until the count is back under the
    // new plan's limit (assertCanAddWorker enforces that going forward).
    const company = await Company.findByIdAndUpdate(
        getReqUser(req).company_id,
        { plan: data.plan },
        { new: true }
    ).select("plan maxWorkers");
    if (!company) throw new NotFoundError("Company not found.");

    res.status(StatusCodes.OK).json({ success: true, plan: company.plan });
};
