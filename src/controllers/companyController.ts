import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { getReqUser, MiddlewareFn } from "../interfaces/expresstype.js";
import Company from "../models/company.js";

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

    // settings is Zod-validated and only contains allowlisted keys — never
    // spread req.body directly into the model.
    const company = await Company.findByIdAndUpdate(
        getReqUser(req).company_id,
        { $set: settings },
        { new: true, runValidators: true }
    ).select(COMPANY_SETTINGS_FIELDS.join(" "));

    if (!company) throw new NotFoundError("Company not found.");

    res.status(StatusCodes.OK).json({ success: true, settings: company });
};
