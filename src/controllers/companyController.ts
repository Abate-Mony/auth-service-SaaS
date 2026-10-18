import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { getReqUser, MiddlewareFn } from "../interfaces/expresstype.js";
import Company from "../models/company.js";
import { assertFeatureEnabledForCompany } from "../utils/planLimits.js";
import { PLANS, PLAN_LIMITS, PLAN_CATALOG, PLAN_FEATURE_LABELS, type PlanFeatures } from "../utils/constant.js";
import { uploadFileToCloudinary, deleteFileFromCloudinary } from "../utils/cloudinaryUpload.js";
import { generatePublicSlug } from "../utils/publicSlug.js";
import { GRANT_STATUSES } from "./billingController.js";

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
    "paymentRemindersEnabled",
    "autoGenerateRecurringInvoices",
] as const;

// Read-only here — included so GET /companies/settings hands the frontend
// the current pick alongside everything else, but it's never in
// companySettingsSchema below, so the bulk PATCH can't touch it. Writing it
// goes through setDefaultInvoiceTemplate instead (invoiceTemplateController.ts),
// which needs an async ownership check this synchronous Zod schema can't do.
const COMPANY_READ_ONLY_EXTRA_FIELDS = ["defaultInvoiceTemplate"] as const;

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
        paymentRemindersEnabled: z.boolean(),
        autoGenerateRecurringInvoices: z.boolean(),
    })
    .partial() // PATCH — every field optional, unknown keys rejected below
    .strict();

// Company branding, not an operational setting — kept separate from
// COMPANY_SETTINGS_FIELDS (geofence/pay/scheduling policy) on purpose.
// Admin-only: a company's logo is a shared, account-wide asset.
export const uploadCompanyLogo: MiddlewareFn = async (req, res) => {
    const companyId = getReqUser(req).company_id;
    const file = (req as any).file;
    if (!file) throw new BadRequestError("Select a logo to upload.");

    const company = await Company.findById(companyId).select("logo");
    if (!company) throw new NotFoundError("Company not found.");

    if (company.logo?.publicId) {
        await deleteFileFromCloudinary(company.logo.publicId, company.logo.resourceType as "image" | "raw");
    }

    const uploaded = await uploadFileToCloudinary(file, `company-logos/${companyId}`);

    company.logo = {
        url: uploaded.url,
        publicId: uploaded.publicId,
        resourceType: uploaded.resourceType,
        mimeType: file.mimetype,
        uploadedAt: new Date(),
    } as any;
    await company.save();

    res.status(StatusCodes.OK).json({ logo: company.logo });
};

export const deleteCompanyLogo: MiddlewareFn = async (req, res) => {
    const companyId = getReqUser(req).company_id;
    const company = await Company.findById(companyId).select("logo");
    if (!company) throw new NotFoundError("Company not found.");

    if (company.logo?.publicId) {
        await deleteFileFromCloudinary(company.logo.publicId, company.logo.resourceType as "image" | "raw");
    }
    company.logo = null;
    await company.save();

    res.status(StatusCodes.OK).json({ logo: null });
};

export const getCompanySettings: MiddlewareFn = async (req, res) => {
    // Deliberately NOT .lean() — a company created before one of these
    // settings fields existed on the schema has it genuinely absent from
    // the stored document (a Mongoose `default:` only applies going
    // forward, never backfilling an existing document). .lean() returns
    // the raw stored data as-is, missing field and all; a normal hydrated
    // document applies the schema's own default for any path that's
    // absent, so this always comes back complete without duplicating
    // every default value here too. The frontend was silently relying on
    // every field always being present and failing closed (no save
    // possible at all, no visible error) the moment one wasn't.
    const company = await Company.findById(getReqUser(req).company_id)
        .select([...COMPANY_SETTINGS_FIELDS, ...COMPANY_READ_ONLY_EXTRA_FIELDS].join(" "));

    if (!company) throw new NotFoundError("Company not found.");

    res.status(StatusCodes.OK).json({ success: true, settings: company.toObject() });
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
// Public quote intake link
// ─────────────────────────────────────────────────────────────
// A dedicated opaque identifier for the public quote-request wizard
// (quotes.onclockly.com/<slug> — publicQuoteIntakeController.ts), never
// the company's real API key. Rotating it only breaks that one link, not
// anything authenticated.

function buildPublicQuoteUrl(slug: string): string {
    const base = process.env.PUBLIC_QUOTE_URL;
    return base ? `${base.replace(/\/$/, "")}/${slug}` : `/${slug}`;
}

export const getPublicQuoteLink: MiddlewareFn = async (req, res) => {
    const company = await Company.findById(getReqUser(req).company_id).select("publicQuoteSlug").lean();
    if (!company) throw new NotFoundError("Company not found.");

    res.status(StatusCodes.OK).json({
        success: true,
        slug: company.publicQuoteSlug ?? null,
        url: company.publicQuoteSlug ? buildPublicQuoteUrl(company.publicQuoteSlug) : null,
    });
};

// Generates a slug on first call, replaces it on every call after —
// "rotate" and "create" are the same operation here, there's nothing to
// distinguish between a first-time setup and a deliberate reset.
export const rotatePublicQuoteLink: MiddlewareFn = async (req, res) => {
    const companyId = getReqUser(req).company_id;

    let slug = generatePublicSlug();
    for (let attempt = 0; attempt < 5; attempt++) {
        const taken = await Company.exists({ publicQuoteSlug: slug });
        if (!taken) break;
        slug = generatePublicSlug();
    }

    const company = await Company.findByIdAndUpdate(companyId, { $set: { publicQuoteSlug: slug } }, { new: true })
        .select("publicQuoteSlug")
        .lean();
    if (!company) throw new NotFoundError("Company not found.");

    res.status(StatusCodes.OK).json({
        success: true,
        slug: company.publicQuoteSlug,
        url: buildPublicQuoteUrl(company.publicQuoteSlug!),
    });
};

// ─────────────────────────────────────────────────────────────
// Plan
// ─────────────────────────────────────────────────────────────
// Real Stripe billing now lives in billingController.ts (checkout/portal
// sessions + webhook sync) — this section keeps the public catalog read
// and the own-plan read, plus the narrowed free-only downgrade endpoint
// (see updateCompanyPlan's own comment below).

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
    const company = await Company.findById(getReqUser(req).company_id)
        .select("plan maxWorkers stripeCustomerId subscriptionStatus currentPeriodEnd cancelAtPeriodEnd trialEndsAt")
        .lean();
    if (!company) throw new NotFoundError("Company not found.");

    const plan = company.plan as keyof typeof PLAN_LIMITS;
    // Only meaningful while still in the future AND not already superseded
    // by a real paid subscription — a company that converted early keeps
    // its (now past-tense) trialEndsAt in the DB, but it's no longer "on a
    // trial" in any sense the frontend should act on.
    const isOnTrial =
        !!company.trialEndsAt &&
        company.trialEndsAt > new Date() &&
        !(company.stripeCustomerId && company.subscriptionStatus && GRANT_STATUSES.includes(company.subscriptionStatus));
    res.status(StatusCodes.OK).json({
        success: true,
        plan,
        maxWorkers: company.maxWorkers ?? PLAN_LIMITS[plan].maxWorkers,
        limits: PLAN_LIMITS[plan],
        hasStripeCustomer: !!company.stripeCustomerId,
        subscriptionStatus: company.subscriptionStatus ?? null,
        currentPeriodEnd: company.currentPeriodEnd ?? null,
        cancelAtPeriodEnd: company.cancelAtPeriodEnd ?? false,
        isOnTrial,
        trialEndsAt: isOnTrial ? company.trialEndsAt : null,
    });
};

// Real billing (billingController.ts) now owns every path that grants a
// paid tier — this endpoint only ever accepts "free", and only once Stripe
// confirms there's nothing live to protect. A company with a live (non-
// cancelled) Stripe subscription must downgrade through the Billing
// Portal's own cancel flow instead, so Stripe's billing status and
// Company.plan stay in sync — self-assigning "free" here while Stripe kept
// billing them would silently desync the two.
const planSchema = z.object({ plan: z.literal("free") }).strict();

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

    const company = await Company.findById(getReqUser(req).company_id)
        .select("plan maxWorkers stripeSubscriptionId subscriptionStatus");
    if (!company) throw new NotFoundError("Company not found.");

    const hasLiveSubscription = company.stripeSubscriptionId
        && company.subscriptionStatus
        && !["canceled", "incomplete_expired"].includes(company.subscriptionStatus);
    if (hasLiveSubscription) {
        throw new BadRequestError("Cancel your subscription from Manage Billing to move to the Free plan.");
    }

    company.plan = data.plan;
    await company.save();

    res.status(StatusCodes.OK).json({ success: true, plan: company.plan });
};
