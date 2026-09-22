import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import mongoose from "mongoose";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import Company from "../models/company.js";
import User from "../models/userModel.js";
import Job from "../models/jobModel.js";
import Client from "../models/clientModel.js";
import Site from "../models/siteModel.js";
import Quote from "../models/quoteModel.js";
import Invoice from "../models/invoiceModel.js";
import PlatformAuditLog, { PLATFORM_AUDIT_ACTIONS } from "../models/PlatformAuditLog.js";
import { recordPlatformAudit } from "../services/platformAudit.service.js";
import { getEffectiveMaxWorkers } from "../utils/planLimits.js";
import { PLANS } from "../utils/constant.js";
import {
  triggerResendDomainVerification,
  fetchResendDomain,
  removeResendDomain,
} from "../utils/resendDomain.js";

// ─────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────

const parseOrThrow = <T>(schema: z.ZodSchema<T>, body: unknown): T => {
  try {
    return schema.parse(body);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new BadRequestError(err.issues[0]?.message ?? "Invalid request.");
    }
    throw err;
  }
};

// Query params are always strings; same convention as jobController.ts's
// getAllJobs. Hard-capped at 100 per page regardless of what's requested —
// these routes intentionally query across every tenant, so they need more
// discipline than a normal per-company list endpoint.
const parsePagination = (query: Record<string, string | undefined>) => {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 25));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
};

// Express 5's route-param typing allows string[] (repeated-name segments),
// which none of these routes actually use — an assertion function narrows
// the param back to `string` for the rest of each handler after validating
// it's both a single value and a real ObjectId, instead of re-casting at
// every later use site.
function requireObjectId(id: string | string[], label: string): asserts id is string {
  if (Array.isArray(id) || !mongoose.Types.ObjectId.isValid(id)) {
    throw new BadRequestError(`Invalid ${label}.`);
  }
}

function serializeEmailSettings(emailSettings: any) {
  const s = emailSettings ?? {};
  return {
    provider: s.provider ?? "inprn",
    senderName: s.senderName ?? "",
    senderEmail: s.senderEmail ?? "",
    replyToEmail: s.replyToEmail ?? "",
    sendingDomain: s.sendingDomain ?? "",
    domainStatus: s.domainStatus ?? "not_connected",
    verifiedAt: s.verifiedAt ?? null,
    lastVerificationCheckAt: s.lastVerificationCheckAt ?? null,
    // resendDomainId deliberately excluded — provider-internal, never
    // returned to any frontend, platform included (same rule as
    // companyEmailController.ts's own serializeEmailSettings).
  };
}

const reasonSchema = z.object({ reason: z.string().trim().min(1, "A reason is required.").max(500) });

// ─────────────────────────────────────────────────────────────────────────
// Overview
// ─────────────────────────────────────────────────────────────────────────

// GET /platform/overview
export const getPlatformOverview: MiddlewareFn = async (_req, res) => {
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  const [totalCompanies, activeCompanies, newThisMonth, activeWorkers, verifiedDomains, failedDomains, recentActivity] =
    await Promise.all([
      Company.countDocuments({}),
      Company.countDocuments({ status: "active" }),
      Company.countDocuments({ createdAt: { $gte: startOfMonth } }),
      User.countDocuments({ role: "worker", isActive: true }),
      Company.countDocuments({ "emailSettings.domainStatus": "verified" }),
      Company.countDocuments({ "emailSettings.domainStatus": "failed" }),
      PlatformAuditLog.find({}).sort({ createdAt: -1 }).limit(10).lean(),
    ]);

  // "Needs attention" — derived from real state, not hardcoded. Bounded by
  // an indexed status/plan lookup rather than scanning every company.
  const attentionCompanies = await Company.find({ status: { $ne: "active" } })
    .select("name status")
    .limit(25)
    .lean();
  const failedDomainCompanies = await Company.find({ "emailSettings.domainStatus": "failed" })
    .select("name")
    .limit(25)
    .lean();

  const attention = [
    ...attentionCompanies.map(c => ({
      type: c.status === "suspended" ? "company_suspended" : "company_disabled",
      severity: "warning" as const,
      company: { id: c._id.toString(), name: c.name },
      message: `${c.name} is ${c.status}`,
    })),
    ...failedDomainCompanies.map(c => ({
      type: "email_domain_failed" as const,
      severity: "warning" as const,
      company: { id: c._id.toString(), name: c.name },
      message: `${c.name}'s sending domain failed verification`,
    })),
  ];

  res.status(StatusCodes.OK).json({
    success: true,
    overview: {
      companies: { total: totalCompanies, active: activeCompanies, newThisMonth },
      users: { activeWorkers },
      // No billing/subscription integration exists in this backend today
      // (see companyController.ts's updateCompanyPlan — plan changes are
      // just a field set, no Stripe/provider behind them) — omitted rather
      // than fabricated. Same for trials: no trial concept exists.
      subscriptions: null,
      trials: null,
      email: { verifiedDomains, failedDomains },
      attention,
      recentActivity: recentActivity.map(a => ({
        id: a._id.toString(),
        action: a.action,
        actorEmail: a.actorEmail,
        targetType: a.targetType,
        targetId: a.targetId,
        company: a.company ?? null,
        result: a.result,
        createdAt: a.createdAt,
      })),
    },
  });
};

// ─────────────────────────────────────────────────────────────────────────
// Companies
// ─────────────────────────────────────────────────────────────────────────

const COMPANY_STATUS_VALUES = ["active", "suspended", "disabled"] as const;

// GET /platform/companies
export const getPlatformCompanies: MiddlewareFn = async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query as Record<string, string | undefined>);
  const { search, status, plan, sort } = req.query as Record<string, string | undefined>;

  const query: Record<string, unknown> = {};
  if (status) {
    if (!(COMPANY_STATUS_VALUES as readonly string[]).includes(status)) {
      throw new BadRequestError("Invalid status filter.");
    }
    query.status = status;
  }
  if (plan) {
    if (!(PLANS as readonly string[]).includes(plan)) throw new BadRequestError("Invalid plan filter.");
    query.plan = plan;
  }
  if (search) {
    // Escaped so a search string can't be used to inject regex.
    const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.name = { $regex: escaped, $options: "i" };
  }

  const SORT_WHITELIST: Record<string, string> = {
    "-createdAt": "-createdAt",
    createdAt: "createdAt",
    name: "name",
    "-name": "-name",
  };
  const sortKey = (sort && SORT_WHITELIST[sort]) || "-createdAt";

  const [companies, total] = await Promise.all([
    Company.find(query).sort(sortKey).skip(skip).limit(limit).populate("owner", "fullname email").lean(),
    Company.countDocuments(query),
  ]);

  const workerCounts = await User.aggregate([
    { $match: { company: { $in: companies.map(c => c._id) }, role: "worker", isActive: true } },
    { $group: { _id: "$company", count: { $sum: 1 } } },
  ]);
  const workerCountByCompany = new Map(workerCounts.map(w => [w._id.toString(), w.count]));

  res.status(StatusCodes.OK).json({
    success: true,
    data: companies.map(c => {
      const limit = getEffectiveMaxWorkers({ plan: c.plan as any, maxWorkers: c.maxWorkers });
      const owner = c.owner as any;
      return {
        id: c._id.toString(),
        name: c.name,
        owner: owner ? { id: owner._id.toString(), name: owner.fullname, email: owner.email } : null,
        plan: c.plan,
        workerUsage: {
          active: workerCountByCompany.get(c._id.toString()) ?? 0,
          limit: limit === -1 ? null : limit,
          unlimited: limit === -1,
        },
        status: c.status ?? "active",
        createdAt: c.createdAt,
      };
    }),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

// GET /platform/companies/:companyId
export const getPlatformCompanyDetail: MiddlewareFn = async (req, res) => {
  const { companyId } = req.params;
  requireObjectId(companyId, "company id");

  const company = await Company.findById(companyId).populate("owner", "fullname email").lean();
  if (!company) throw new NotFoundError("Company not found.");

  const [workers, managers, admins, clients, sites, jobs, quotes, invoices] = await Promise.all([
    User.countDocuments({ company: companyId, role: "worker", isActive: true }),
    User.countDocuments({ company: companyId, role: "manager", isActive: true }),
    User.countDocuments({ company: companyId, role: { $in: ["admin", "owner"] }, isActive: true }),
    Client.countDocuments({ company: companyId, isDeleted: false }),
    Site.countDocuments({ company: companyId, isDeleted: false }),
    // Job.company is schema-typed String (see planLimits.ts's own note).
    Job.countDocuments({ company: companyId.toString(), isDeleted: false, isTemplate: false }),
    Quote.countDocuments({ company: companyId, isDeleted: false }),
    Invoice.countDocuments({ company: companyId, isDeleted: false }),
  ]);

  const limit = getEffectiveMaxWorkers({ plan: company.plan as any, maxWorkers: company.maxWorkers });
  const owner = company.owner as any;

  res.status(StatusCodes.OK).json({
    success: true,
    company: {
      id: company._id.toString(),
      name: company.name,
      businessType: company.businessType,
      size: company.size,
      country: company.country,
      owner: owner ? { id: owner._id.toString(), name: owner.fullname, email: owner.email } : null,
      plan: company.plan,
      workerUsage: { active: workers, limit: limit === -1 ? null : limit, unlimited: limit === -1 },
      status: company.status ?? "active",
      email: { domainStatus: company.emailSettings?.domainStatus ?? "not_connected" },
      counts: { workers, managers, admins, clients, sites, jobs, quotes, invoices },
      createdAt: company.createdAt,
    },
  });
};

// GET /platform/companies/:companyId/users
export const getPlatformCompanyUsers: MiddlewareFn = async (req, res) => {
  const { companyId } = req.params;
  requireObjectId(companyId, "company id");

  const { page, limit, skip } = parsePagination(req.query as Record<string, string | undefined>);
  const { search, role } = req.query as Record<string, string | undefined>;

  const query: Record<string, unknown> = { company: companyId };
  if (role) query.role = role;
  if (search) {
    const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.$or = [{ fullname: { $regex: escaped, $options: "i" } }, { email: { $regex: escaped, $options: "i" } }];
  }

  const [users, total] = await Promise.all([
    User.find(query).select("fullname email role platformRole isActive createdAt lastLogin").sort("-createdAt").skip(skip).limit(limit).lean(),
    User.countDocuments(query),
  ]);

  res.status(StatusCodes.OK).json({
    success: true,
    data: users.map(u => ({
      id: u._id.toString(),
      name: u.fullname,
      email: u.email,
      role: u.role,
      // Never collapsed into `role` — a completely separate axis.
      platformRole: u.platformRole ?? null,
      accountStatus: u.isActive === false ? "disabled" : "active",
      lastActive: u.lastLogin ?? null,
      createdAt: u.createdAt,
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

// GET /platform/companies/:companyId/usage
export const getPlatformCompanyUsage: MiddlewareFn = async (req, res) => {
  const { companyId } = req.params;
  requireObjectId(companyId, "company id");

  const company = await Company.findById(companyId).select("plan maxWorkers").lean();
  if (!company) throw new NotFoundError("Company not found.");

  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  const [activeWorkers, jobsThisMonth, quotesThisMonth, invoicesThisMonth] = await Promise.all([
    User.countDocuments({ company: companyId, role: "worker", isActive: true }),
    Job.countDocuments({ company: companyId.toString(), isDeleted: false, isTemplate: false, createdAt: { $gte: startOfMonth } }),
    Quote.countDocuments({ company: companyId, isDeleted: false, createdAt: { $gte: startOfMonth } }),
    Invoice.countDocuments({ company: companyId, isDeleted: false, createdAt: { $gte: startOfMonth } }),
  ]);

  const limit = getEffectiveMaxWorkers(company as any);

  res.status(StatusCodes.OK).json({
    success: true,
    usage: {
      workerSeats: { active: activeWorkers, limit: limit === -1 ? null : limit, unlimited: limit === -1 },
      // Basis: createdAt for all three — documented explicitly since the
      // brief warns against silently mixing definitions (e.g. sentAt for
      // quotes vs. createdAt).
      jobsThisMonth,
      quotesThisMonth,
      invoicesThisMonth,
    },
  });
};

// GET /platform/companies/:companyId/email
export const getPlatformCompanyEmail: MiddlewareFn = async (req, res) => {
  const { companyId } = req.params;
  requireObjectId(companyId, "company id");

  const company = await Company.findById(companyId).select("emailSettings").lean();
  if (!company) throw new NotFoundError("Company not found.");

  res.status(StatusCodes.OK).json({ success: true, settings: serializeEmailSettings(company.emailSettings) });
};

// ─────────────────────────────────────────────────────────────────────────
// Users (cross-tenant)
// ─────────────────────────────────────────────────────────────────────────

// GET /platform/users
export const getPlatformUsers: MiddlewareFn = async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query as Record<string, string | undefined>);
  const { search, role, company, platformRole } = req.query as Record<string, string | undefined>;

  const query: Record<string, unknown> = {};
  if (role) query.role = role;
  if (company) {
    requireObjectId(company, "company id");
    query.company = company;
  }
  if (platformRole) query.platformRole = platformRole;
  if (search) {
    const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.$or = [{ fullname: { $regex: escaped, $options: "i" } }, { email: { $regex: escaped, $options: "i" } }];
  }

  const [users, total] = await Promise.all([
    User.find(query)
      .select("fullname email role platformRole isActive createdAt lastLogin company")
      .populate("company", "name")
      .sort("-createdAt")
      .skip(skip)
      .limit(limit)
      .lean(),
    User.countDocuments(query),
  ]);

  res.status(StatusCodes.OK).json({
    success: true,
    data: users.map(u => {
      const c = u.company as any;
      return {
        id: u._id.toString(),
        name: u.fullname,
        email: u.email,
        role: u.role,
        platformRole: u.platformRole ?? null,
        company: c ? { id: c._id.toString(), name: c.name } : null,
        accountStatus: u.isActive === false ? "disabled" : "active",
        createdAt: u.createdAt,
      };
    }),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

// GET /platform/users/:userId
export const getPlatformUserDetail: MiddlewareFn = async (req, res) => {
  const { userId } = req.params;
  requireObjectId(userId, "user id");

  const user = await User.findById(userId)
    .select("fullname email role platformRole isActive createdAt lastLogin company")
    .populate("company", "name")
    .lean();
  if (!user) throw new NotFoundError("User not found.");

  const c = user.company as any;
  res.status(StatusCodes.OK).json({
    success: true,
    user: {
      id: user._id.toString(),
      name: user.fullname,
      email: user.email,
      role: user.role,
      platformRole: user.platformRole ?? null,
      company: c ? { id: c._id.toString(), name: c.name } : null,
      accountStatus: user.isActive === false ? "disabled" : "active",
      createdAt: user.createdAt,
      lastLoginAt: user.lastLogin ?? null,
      // Deliberately excluded: password, refreshToken, resetToken,
      // verification tokens — none of those fields are selected above.
    },
  });
};

// ─────────────────────────────────────────────────────────────────────────
// Mutations — every one of these is audited (see recordPlatformAudit calls).
// ─────────────────────────────────────────────────────────────────────────

const companyStatusSchema = reasonSchema.extend({ status: z.enum(COMPANY_STATUS_VALUES) });

// PATCH /platform/companies/:companyId/status
export const updateCompanyStatus: MiddlewareFn = async (req, res) => {
  const { companyId } = req.params;
  requireObjectId(companyId, "company id");
  const data = parseOrThrow(companyStatusSchema, req.body);

  const company = await Company.findById(companyId).select("status name");
  if (!company) throw new NotFoundError("Company not found.");

  const before = { status: company.status ?? "active" };
  company.status = data.status;
  await company.save();
  const after = { status: company.status };

  await recordPlatformAudit({
    req,
    actor: req.platformActor!,
    action: "company.status.changed",
    targetType: "Company",
    targetId: companyId,
    company: companyId,
    reason: data.reason,
    before,
    after,
    result: "success",
  });

  res.status(StatusCodes.OK).json({ success: true, msg: "Company status updated.", company: { id: companyId, status: company.status } });
};

const companyPlanSchema = reasonSchema.extend({ plan: z.enum(PLANS) });

// PATCH /platform/companies/:companyId/plan
// Manual override only — see updateCompanyPlan in companyController.ts and
// its own comment: there is no billing provider behind plan changes in this
// backend, so this (like the tenant-facing version) is just a field set,
// now with a required reason and an audit trail.
export const updateCompanyPlanOverride: MiddlewareFn = async (req, res) => {
  const { companyId } = req.params;
  requireObjectId(companyId, "company id");
  const data = parseOrThrow(companyPlanSchema, req.body);

  const company = await Company.findById(companyId).select("plan name");
  if (!company) throw new NotFoundError("Company not found.");

  const before = { plan: company.plan };
  company.plan = data.plan;
  await company.save();
  const after = { plan: company.plan };

  await recordPlatformAudit({
    req,
    actor: req.platformActor!,
    action: "company.plan.changed",
    targetType: "Company",
    targetId: companyId,
    company: companyId,
    reason: data.reason,
    before,
    after,
    result: "success",
  });

  res.status(StatusCodes.OK).json({ success: true, msg: "Company plan updated.", company: { id: companyId, plan: company.plan } });
};

const userStatusSchema = reasonSchema.extend({ status: z.enum(["active", "disabled"]) });

// PATCH /platform/users/:userId/status
// Wires up User.isActive, which existed on the schema but was never
// actually settable anywhere in the app (see the backend audit — no
// deactivate-worker endpoint existed before this). Note the real limitation
// documented in platformAuthMiddleware.ts/authMiddleware.ts: authenticateUser
// is a stateless JWT check with no per-request DB hit, so a disabled user's
// still-valid access token keeps working for up to 15 minutes (its natural
// expiry) rather than being revoked immediately. True immediate revocation
// would need a token-version field threaded through every issuance/
// verification path — out of scope here per the brief's own caution against
// introducing that casually.
export const updateUserStatus: MiddlewareFn = async (req, res) => {
  const { userId } = req.params;
  requireObjectId(userId, "user id");
  const data = parseOrThrow(userStatusSchema, req.body);

  const user = await User.findById(userId).select("isActive email company");
  if (!user) throw new NotFoundError("User not found.");

  const before = { isActive: user.isActive !== false };
  user.isActive = data.status === "active";
  await user.save();
  const after = { isActive: user.isActive };

  await recordPlatformAudit({
    req,
    actor: req.platformActor!,
    action: "user.status.changed",
    targetType: "User",
    targetId: userId,
    company: user.company ? user.company.toString() : null,
    reason: data.reason,
    before,
    after,
    result: "success",
  });

  res.status(StatusCodes.OK).json({ success: true, msg: "User status updated.", user: { id: userId, status: data.status } });
};

// POST /platform/email-domains/:companyId/retry-verification
export const retryEmailDomainVerification: MiddlewareFn = async (req, res) => {
  const { companyId } = req.params;
  requireObjectId(companyId, "company id");

  const company = await Company.findById(companyId).select("emailSettings");
  if (!company) throw new NotFoundError("Company not found.");

  const settings = (company.emailSettings ?? {}) as any;
  if (!settings.resendDomainId) throw new BadRequestError("This company has no sending domain connected.");

  const before = { domainStatus: settings.domainStatus };
  await triggerResendDomainVerification(settings.resendDomainId);
  const fetched = await fetchResendDomain(settings.resendDomainId);

  settings.domainStatus = fetched.status;
  settings.lastVerificationCheckAt = new Date();
  if (fetched.status === "verified" && !settings.verifiedAt) settings.verifiedAt = new Date();
  company.emailSettings = settings;
  await company.save();

  await recordPlatformAudit({
    req,
    actor: req.platformActor!,
    action: "email_domain.retry_verification",
    targetType: "Company",
    targetId: companyId,
    company: companyId,
    before,
    after: { domainStatus: settings.domainStatus },
    result: "success",
  });

  res.status(StatusCodes.OK).json({ success: true, settings: serializeEmailSettings(settings) });
};

// POST /platform/email-domains/:companyId/reset
// Destructive — clears the custom-domain config only, falls back the
// company's sending to the INPRN default sender automatically (nothing
// else reads resendDomainId/sendingDomain once domainStatus resets to
// not_connected, per resolveCompanySender's own domainStatus check).
export const resetEmailDomain: MiddlewareFn = async (req, res) => {
  const { companyId } = req.params;
  requireObjectId(companyId, "company id");
  const data = parseOrThrow(reasonSchema, req.body);

  const company = await Company.findById(companyId).select("emailSettings");
  if (!company) throw new NotFoundError("Company not found.");

  const settings = (company.emailSettings ?? {}) as any;
  const before = { ...settings };

  if (settings.resendDomainId) {
    try {
      await removeResendDomain(settings.resendDomainId);
    } catch (err) {
      // Provider-side cleanup failing shouldn't block clearing our own
      // state — the domain may already be gone on Resend's side.
      console.error("[platform] failed to remove Resend domain during reset:", err);
    }
  }

  settings.resendDomainId = "";
  settings.sendingDomain = "";
  settings.domainStatus = "not_connected";
  settings.verifiedAt = null;
  settings.lastVerificationCheckAt = null;
  // senderName/senderEmail/replyToEmail/provider preserved — same as the
  // tenant-facing removeEmailDomain in companyEmailController.ts.
  company.emailSettings = settings;
  await company.save();

  await recordPlatformAudit({
    req,
    actor: req.platformActor!,
    action: "email_domain.reset",
    targetType: "Company",
    targetId: companyId,
    company: companyId,
    reason: data.reason,
    before,
    after: { ...settings },
    result: "success",
  });

  res.status(StatusCodes.OK).json({ success: true, settings: serializeEmailSettings(settings) });
};

// ─────────────────────────────────────────────────────────────────────────
// Audit
// ─────────────────────────────────────────────────────────────────────────

// GET /platform/audit
export const getPlatformAuditList: MiddlewareFn = async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query as Record<string, string | undefined>);
  const { actor, action, company, targetType, result, from, to } = req.query as Record<string, string | undefined>;

  const query: Record<string, unknown> = {};
  if (actor) {
    requireObjectId(actor, "actor id");
    query.actor = actor;
  }
  if (action) {
    if (!(PLATFORM_AUDIT_ACTIONS as readonly string[]).includes(action)) throw new BadRequestError("Invalid action filter.");
    query.action = action;
  }
  if (company) {
    requireObjectId(company, "company id");
    query.company = company;
  }
  if (targetType) query.targetType = targetType;
  if (result) {
    if (!["success", "failed", "denied"].includes(result)) throw new BadRequestError("Invalid result filter.");
    query.result = result;
  }
  if (from || to) {
    const createdAt: Record<string, Date> = {};
    if (from) createdAt.$gte = new Date(from);
    if (to) createdAt.$lte = new Date(to);
    query.createdAt = createdAt;
  }

  const [records, total] = await Promise.all([
    PlatformAuditLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    PlatformAuditLog.countDocuments(query),
  ]);

  res.status(StatusCodes.OK).json({
    success: true,
    // Compact list DTO — no before/after/metadata blobs, per the brief.
    data: records.map(r => ({
      id: r._id.toString(),
      actorEmail: r.actorEmail,
      actorPlatformRole: r.actorPlatformRole,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      company: r.company ?? null,
      result: r.result,
      reason: r.reason,
      createdAt: r.createdAt,
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

// GET /platform/audit/:eventId
export const getPlatformAuditDetail: MiddlewareFn = async (req, res) => {
  const { eventId } = req.params;
  requireObjectId(eventId, "event id");

  const record = await PlatformAuditLog.findById(eventId).lean();
  if (!record) throw new NotFoundError("Audit record not found.");

  res.status(StatusCodes.OK).json({
    success: true,
    event: {
      id: record._id.toString(),
      actor: record.actor,
      actorEmail: record.actorEmail,
      actorPlatformRole: record.actorPlatformRole,
      action: record.action,
      targetType: record.targetType,
      targetId: record.targetId,
      company: record.company ?? null,
      reason: record.reason,
      before: record.before,
      after: record.after,
      result: record.result,
      metadata: record.metadata,
      source: record.source,
      createdAt: record.createdAt,
    },
  });
};

// ─────────────────────────────────────────────────────────────────────────
// System
// ─────────────────────────────────────────────────────────────────────────

// GET /platform/system — deliberately minimal, no monitoring/metrics
// infrastructure exists in this backend to report real latency/uptime
// numbers from, so this only reports what can actually be checked live.
export const getPlatformSystem: MiddlewareFn = async (_req, res) => {
  const dbState = mongoose.connection.readyState; // 1 = connected
  res.status(StatusCodes.OK).json({
    success: true,
    system: {
      api: { status: "operational" },
      database: { status: dbState === 1 ? "operational" : "degraded" },
    },
  });
};
