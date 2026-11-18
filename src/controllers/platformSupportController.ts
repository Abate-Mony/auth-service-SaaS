import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import Company from "../models/company.js";
import User from "../models/userModel.js";
import Job from "../models/jobModel.js";
import JobAssignment from "../models/JobAssignment.js";
import Client from "../models/clientModel.js";
import Site from "../models/siteModel.js";
import Quote from "../models/quoteModel.js";
import Invoice from "../models/invoiceModel.js";
import RecurringJob from "../models/recurringJobModel.js";
import TimeOffRequest from "../models/TimeOffRequest.js";
import PlatformCompanyNote from "../models/PlatformCompanyNote.js";
import PlatformSupportSession from "../models/PlatformSupportSession.js";
import ApiKey from "../models/apiKeyModel.js";
import { recordPlatformAudit } from "../services/platformAudit.service.js";
import { parseOrThrow, reasonSchema, requireObjectId } from "./platformController.js";
import { GRANT_STATUSES, getStripe } from "./billingController.js";
import { FEATURE_FLAGS, FEATURE_FLAG_KEYS, PLATFORM_TAGS } from "../utils/featureFlags.js";
import { createEmailVerificationToken, createPasswordResetToken } from "../utils/tokenUtils.js";
import { sendPasswordResetEmail, sendSupportAccessNotice, sendVerificationEmail } from "../utils/mailTemplates.js";
import { sendPushToUser } from "../utils/webPush.js";
import { sendExpoPushToUser } from "../utils/expoPush.js";

// Platform support tools: notes & tags, trial/billing actions, feature
// flags, read-only support access, data export & scheduled deletion, and
// user account recovery. Every change is audited (recordPlatformAudit) and,
// except notes/tags, requires a reason. Role checks per route live in
// platformRouter.ts.

const DAY = 24 * 60 * 60 * 1000;
export const DELETION_GRACE_DAYS = 30;

const actorOf = (req: Parameters<MiddlewareFn>[0]) => req.platformActor!;

const hasLivePaidSubscription = (c: { stripeSubscriptionId?: string | null; subscriptionStatus?: string | null }) =>
  !!c.stripeSubscriptionId && GRANT_STATUSES.includes(c.subscriptionStatus ?? "");

async function loadCompany(companyId: string, select = "") {
  requireObjectId(companyId, "company id");
  const company = await Company.findById(companyId).select(select);
  if (!company) throw new NotFoundError("Company not found.");
  return company;
}

async function loadUser(userId: string, select = "") {
  requireObjectId(userId, "user id");
  const user = await User.findById(userId).select(select);
  if (!user) throw new NotFoundError("User not found.");
  return user;
}

// ─────────────────────────────────────────────────────────────────────────
// Notes & tags
// ─────────────────────────────────────────────────────────────────────────

// GET /platform/companies/:companyId/notes
export const getCompanyNotes: MiddlewareFn = async (req, res) => {
  const { companyId } = req.params;
  requireObjectId(companyId, "company id");
  const notes = await PlatformCompanyNote.find({ company: companyId }).sort({ createdAt: -1 }).limit(200).lean();
  res.status(StatusCodes.OK).json({
    success: true,
    data: notes.map(n => ({
      id: n._id.toString(),
      body: n.body,
      author: { id: n.author.toString(), email: n.authorEmail },
      createdAt: n.createdAt,
    })),
  });
};

const noteSchema = z.object({ body: z.string().trim().min(1, "Write a note first.").max(4000) });

// POST /platform/companies/:companyId/notes
export const addCompanyNote: MiddlewareFn = async (req, res) => {
  const { companyId } = req.params;
  await loadCompany(companyId as string, "_id");
  const { body } = parseOrThrow(noteSchema, req.body);
  const actor = actorOf(req);
  const note = await PlatformCompanyNote.create({ company: String(companyId), author: actor.id, authorEmail: actor.email, body });
  await recordPlatformAudit({
    req, actor, action: "company.note.added", targetType: "Company", targetId: companyId as string,
    company: companyId as string, after: { noteId: note._id.toString() }, result: "success",
  });
  res.status(StatusCodes.CREATED).json({
    success: true,
    note: { id: note._id.toString(), body: note.body, author: { id: actor.id, email: actor.email }, createdAt: note.createdAt },
  });
};

// DELETE /platform/companies/:companyId/notes/:noteId — the author, or a super admin
export const deleteCompanyNote: MiddlewareFn = async (req, res) => {
  const { companyId, noteId } = req.params;
  requireObjectId(companyId, "company id");
  requireObjectId(noteId, "note id");
  const actor = actorOf(req);
  const note = await PlatformCompanyNote.findOne({ _id: noteId, company: companyId });
  if (!note) throw new NotFoundError("Note not found.");
  if (note.author.toString() !== actor.id && actor.platformRole !== "super_admin") {
    throw new UnauthorizedError("Only the note's author or a super admin can delete it.");
  }
  await note.deleteOne();
  await recordPlatformAudit({
    req, actor, action: "company.note.deleted", targetType: "Company", targetId: companyId,
    company: companyId, before: { noteId, body: note.body }, result: "success",
  });
  res.status(StatusCodes.OK).json({ success: true });
};

const tagsSchema = z.object({
  tags: z.array(z.enum(PLATFORM_TAGS)).max(PLATFORM_TAGS.length),
  reason: z.string().trim().max(500).optional(),
});

// PATCH /platform/companies/:companyId/tags
export const updateCompanyTags: MiddlewareFn = async (req, res) => {
  const { companyId } = req.params;
  const company = await loadCompany(companyId as string, "platformTags");
  const { tags, reason } = parseOrThrow(tagsSchema, req.body);
  const before = { tags: [...(company.platformTags ?? [])] };
  company.platformTags = [...new Set(tags)];
  await company.save();
  await recordPlatformAudit({
    req, actor: actorOf(req), action: "company.tags.changed", targetType: "Company", targetId: companyId as string,
    company: companyId as string, reason: reason || null, before, after: { tags: company.platformTags }, result: "success",
  });
  res.status(StatusCodes.OK).json({ success: true, tags: company.platformTags });
};

const bulkTagsSchema = z.object({
  companyIds: z.array(z.string()).min(1).max(100),
  tags: z.array(z.enum(PLATFORM_TAGS)).max(PLATFORM_TAGS.length),
  reason: z.string().trim().max(500).optional(),
});

// PATCH /platform/companies/bulk/tags — same per-id try/catch and
// partial-success shape as bulkUpdateCompanyStatus in platformController.ts.
// Reason stays optional here, matching updateCompanyTags's own convention
// above — bulk doesn't introduce a stricter rule than the single-row action
// it's built from.
export const bulkUpdateCompanyTags: MiddlewareFn = async (req, res) => {
  const data = parseOrThrow(bulkTagsSchema, req.body);
  data.companyIds.forEach(id => requireObjectId(id, "company id"));

  const succeeded: string[] = [];
  const failed: { companyId: string; error: string }[] = [];

  for (const companyId of data.companyIds) {
    try {
      const company = await Company.findById(companyId).select("platformTags");
      if (!company) throw new Error("Company not found.");

      const before = { tags: [...(company.platformTags ?? [])] };
      company.platformTags = [...new Set(data.tags)];
      await company.save();

      await recordPlatformAudit({
        req,
        actor: actorOf(req),
        action: "company.tags.changed",
        targetType: "Company",
        targetId: companyId,
        company: companyId,
        reason: data.reason || null,
        before,
        after: { tags: company.platformTags },
        result: "success",
        metadata: { bulk: true },
      });
      succeeded.push(companyId);
    } catch (err) {
      failed.push({ companyId, error: err instanceof Error ? err.message : "Unknown error" });
    }
  }

  res.status(StatusCodes.OK).json({ success: failed.length === 0, succeeded, failed });
};

// ─────────────────────────────────────────────────────────────────────────
// Trial & billing
// ─────────────────────────────────────────────────────────────────────────

const extendTrialSchema = reasonSchema.extend({ days: z.number().int().min(1).max(90) });

// POST /platform/companies/:companyId/trial/extend
// Pushes trialEndsAt out (from today if it already ended) and puts the
// company back on the trial plan if it had reverted to free. Refused once a
// real paid subscription is running — there's no trial to extend then.
export const extendCompanyTrial: MiddlewareFn = async (req, res) => {
  const { companyId } = req.params;
  const company = await loadCompany(companyId as string, "plan trialEndsAt trialUsedAt stripeSubscriptionId subscriptionStatus");
  const { days, reason } = parseOrThrow(extendTrialSchema, req.body);
  if (hasLivePaidSubscription(company)) {
    throw new ConflictError("This company has an active paid subscription — there is no trial to extend.");
  }
  const before = { plan: company.plan, trialEndsAt: company.trialEndsAt ?? null };
  const from = Math.max(Date.now(), company.trialEndsAt ? new Date(company.trialEndsAt).getTime() : 0);
  company.trialEndsAt = new Date(from + days * DAY);
  company.trialUsedAt = company.trialUsedAt ?? new Date();
  if (company.plan === "free") company.plan = "professional"; // the signup trial plan (authControler.ts)
  await company.save();
  const after = { plan: company.plan, trialEndsAt: company.trialEndsAt };
  await recordPlatformAudit({
    req, actor: actorOf(req), action: "company.trial.extended", targetType: "Company", targetId: companyId as string,
    company: companyId as string, reason, before, after, metadata: { days }, result: "success",
  });
  res.status(StatusCodes.OK).json({ success: true, msg: `Trial extended by ${days} days.`, ...after });
};

// POST /platform/companies/:companyId/billing/retry-payment
// Asks Stripe to collect the company's latest unpaid invoice again.
export const retryCompanyPayment: MiddlewareFn = async (req, res) => {
  const { companyId } = req.params;
  const company = await loadCompany(companyId as string, "stripeCustomerId");
  const { reason } = parseOrThrow(reasonSchema, req.body);
  if (!company.stripeCustomerId) throw new BadRequestError("This company has no Stripe customer.");
  if (!process.env.STRIPE_SECRET_KEY) throw new BadRequestError("Stripe isn't configured on this server.");

  const stripe = getStripe();
  const open = await stripe.invoices.list({ customer: company.stripeCustomerId, status: "open", limit: 1 });
  const invoice = open.data[0];
  if (!invoice?.id) throw new BadRequestError("No unpaid Stripe invoice to retry.");

  const audit = (result: "success" | "failed", metadata: Record<string, unknown>) =>
    recordPlatformAudit({
      req, actor: actorOf(req), action: "company.payment.retried", targetType: "Company", targetId: companyId as string,
      company: companyId as string, reason, metadata: { invoiceId: invoice.id, ...metadata }, result,
    });
  try {
    const paid = await stripe.invoices.pay(invoice.id);
    await audit("success", { status: paid.status });
    res.status(StatusCodes.OK).json({ success: true, msg: `Payment ${paid.status === "paid" ? "collected" : "retried"}.`, status: paid.status });
  } catch (err: any) {
    await audit("failed", { error: err?.message ?? String(err) });
    throw new BadRequestError(`Stripe couldn't collect the payment: ${err?.message ?? "unknown error"}`);
  }
};

// ─────────────────────────────────────────────────────────────────────────
// Feature flags
// ─────────────────────────────────────────────────────────────────────────

// GET /platform/feature-flags
export const getFeatureFlagCatalog: MiddlewareFn = async (_req, res) => {
  res.status(StatusCodes.OK).json({ success: true, data: FEATURE_FLAGS, tags: PLATFORM_TAGS });
};

const flagsSchema = reasonSchema.extend({ flags: z.array(z.string()).max(50) });

// PATCH /platform/companies/:companyId/feature-flags
export const updateCompanyFeatureFlags: MiddlewareFn = async (req, res) => {
  const { companyId } = req.params;
  const company = await loadCompany(companyId as string, "featureFlags");
  const { flags, reason } = parseOrThrow(flagsSchema, req.body);
  const unknown = flags.filter(f => !(FEATURE_FLAG_KEYS as string[]).includes(f));
  if (unknown.length) throw new BadRequestError(`Unknown feature flag: ${unknown.join(", ")}`);
  const before = { flags: [...(company.featureFlags ?? [])] };
  company.featureFlags = [...new Set(flags)];
  await company.save();
  await recordPlatformAudit({
    req, actor: actorOf(req), action: "company.feature_flags.changed", targetType: "Company", targetId: companyId as string,
    company: companyId as string, reason, before, after: { flags: company.featureFlags }, result: "success",
  });
  res.status(StatusCodes.OK).json({ success: true, flags: company.featureFlags });
};

// ─────────────────────────────────────────────────────────────────────────
// API keys — the company's own external-integration credentials
// (apiKeyController.ts is the company's self-service version of this).
// Never exposes keyHash; the raw key was only ever shown once, to the
// company itself, at creation time.
// ─────────────────────────────────────────────────────────────────────────

const serializeApiKeyForPlatform = (k: any) => ({
  id: k._id.toString(),
  name: k.name,
  keyPrefix: k.keyPrefix,
  isActive: k.isActive,
  lastUsedAt: k.lastUsedAt,
  createdAt: k.createdAt,
  revokedAt: k.revokedAt,
});

// GET /platform/companies/:companyId/api-keys
export const getCompanyApiKeys: MiddlewareFn = async (req, res) => {
  const { companyId } = req.params;
  requireObjectId(companyId, "company id");
  const keys = await ApiKey.find({ company: companyId }).sort({ createdAt: -1 }).lean();
  res.status(StatusCodes.OK).json({ success: true, data: keys.map(serializeApiKeyForPlatform) });
};

// POST /platform/companies/:companyId/api-keys/:keyId/revoke
// For a leaked key or an integration misbehaving — the company can already
// revoke its own keys; this lets support act on their behalf (e.g. from an
// abuse report) without waiting on them.
export const revokeCompanyApiKey: MiddlewareFn = async (req, res) => {
  const { companyId, keyId } = req.params;
  requireObjectId(companyId, "company id");
  requireObjectId(keyId, "api key id");
  const { reason } = parseOrThrow(reasonSchema, req.body);
  const key = await ApiKey.findOne({ _id: keyId, company: companyId });
  if (!key) throw new NotFoundError("API key not found.");
  if (!key.isActive) throw new BadRequestError("This key is already revoked.");
  key.isActive = false;
  key.revokedAt = new Date();
  await key.save();
  await recordPlatformAudit({
    req, actor: actorOf(req), action: "company.api_key.revoked", targetType: "Company", targetId: companyId as string,
    company: companyId as string, reason, metadata: { keyId: key._id.toString(), keyName: key.name }, result: "success",
  });
  res.status(StatusCodes.OK).json({ success: true, msg: `"${key.name}" revoked.`, apiKey: serializeApiKeyForPlatform(key) });
};

// ─────────────────────────────────────────────────────────────────────────
// Support access ("view as", read-only)
// ─────────────────────────────────────────────────────────────────────────

async function activeSession(actorId: string, companyId: string) {
  return PlatformSupportSession.findOne({
    actor: actorId,
    company: companyId,
    endedAt: null,
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });
}

const sessionJson = (s: any) =>
  s ? { id: s._id.toString(), reason: s.reason, expiresAt: s.expiresAt, createdAt: s.createdAt, ownerNotified: s.ownerNotified } : null;

// GET /platform/companies/:companyId/support-access — this admin's live session, if any
export const getSupportAccess: MiddlewareFn = async (req, res) => {
  const { companyId } = req.params;
  requireObjectId(companyId, "company id");
  res.status(StatusCodes.OK).json({ success: true, session: sessionJson(await activeSession(actorOf(req).id, companyId)) });
};

const startAccessSchema = reasonSchema.extend({
  minutes: z.union([z.literal(15), z.literal(30), z.literal(60)]).default(30),
  notifyOwner: z.boolean().default(true),
});

// POST /platform/companies/:companyId/support-access
export const startSupportAccess: MiddlewareFn = async (req, res) => {
  const { companyId } = req.params;
  const company = await loadCompany(companyId as string, "name owner");
  const { reason, minutes, notifyOwner } = parseOrThrow(startAccessSchema, req.body);
  const actor = actorOf(req);

  // One live session per admin per company: end any open one first
  await PlatformSupportSession.updateMany(
    { actor: actor.id, company: companyId, endedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { endedAt: new Date() } }
  );

  let ownerNotified = false;
  if (notifyOwner && company.owner) {
    const owner = await User.findById(company.owner).select("email fullname").lean();
    if (owner?.email) {
      ownerNotified = true;
      sendSupportAccessNotice({
        email: owner.email, fullname: owner.fullname ?? "there", companyName: company.name,
        supportEmail: actor.email, reason, minutes,
      }).catch(err => console.error(`Failed to send support-access notice for company ${companyId}:`, err));
    }
  }

  const session = await PlatformSupportSession.create({
    actor: actor.id, actorEmail: actor.email, company: String(companyId), reason,
    expiresAt: new Date(Date.now() + minutes * 60 * 1000), ownerNotified,
  });
  await recordPlatformAudit({
    req, actor, action: "company.support_access.started", targetType: "Company", targetId: companyId as string,
    company: companyId as string, reason, metadata: { minutes, ownerNotified, sessionId: session._id.toString() }, result: "success",
  });
  res.status(StatusCodes.CREATED).json({ success: true, session: sessionJson(session) });
};

// POST /platform/companies/:companyId/support-access/end
export const endSupportAccess: MiddlewareFn = async (req, res) => {
  const { companyId } = req.params;
  requireObjectId(companyId, "company id");
  const actor = actorOf(req);
  const session = await activeSession(actor.id, companyId);
  if (session) {
    session.endedAt = new Date();
    await session.save();
    await recordPlatformAudit({
      req, actor, action: "company.support_access.ended", targetType: "Company", targetId: companyId,
      company: companyId, metadata: { sessionId: session._id.toString() }, result: "success",
    });
  }
  res.status(StatusCodes.OK).json({ success: true });
};

async function requireSupportSession(req: Parameters<MiddlewareFn>[0], companyId: string) {
  requireObjectId(companyId, "company id");
  const session = await activeSession(actorOf(req).id, companyId);
  if (!session) throw new UnauthorizedError("Start a support access session for this company first.");
  return session;
}

// GET /platform/companies/:companyId/support/jobs?from=YYYY-MM-DD&to=YYYY-MM-DD
export const getSupportJobs: MiddlewareFn = async (req, res) => {
  const { companyId } = req.params;
  await requireSupportSession(req, companyId as string);
  const { from, to } = req.query as Record<string, string | undefined>;
  const start = from ? new Date(`${from}T00:00:00.000Z`) : new Date(Date.now() - 7 * DAY);
  const end = to ? new Date(`${to}T00:00:00.000Z`) : new Date(Date.now() + 14 * DAY);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new BadRequestError("Invalid date range.");
  if (end.getTime() - start.getTime() > 92 * DAY) throw new BadRequestError("Pick a range of 3 months or less.");

  const jobs = await Job.find({
    company: String(companyId), isDeleted: { $ne: true }, isTemplate: { $ne: true }, date: { $gte: start, $lte: end },
  })
    .select("title date startTime endTime status location requiredWorkers client")
    .populate("client", "name")
    .sort({ date: 1, startTime: 1 })
    .limit(500)
    .lean();
  const assignments = await JobAssignment.find({ job: { $in: jobs.map(j => j._id) }, isDeleted: { $ne: true } })
    .select("job fullname status checkedInAt checkedOutAt")
    .lean();
  const byJob = new Map<string, any[]>();
  for (const a of assignments) byJob.set(String(a.job), [...(byJob.get(String(a.job)) ?? []), a]);

  res.status(StatusCodes.OK).json({
    success: true,
    data: jobs.map(j => ({
      id: j._id.toString(), title: j.title, date: j.date, startTime: j.startTime, endTime: j.endTime,
      status: j.status, location: j.location, requiredWorkers: j.requiredWorkers,
      client: (j.client as any)?.name ?? null,
      workers: (byJob.get(j._id.toString()) ?? []).map(a => ({
        name: a.fullname, status: a.status, clockIn: a.checkedInAt ?? null, clockOut: a.checkedOutAt ?? null,
      })),
    })),
  });
};

// GET /platform/companies/:companyId/support/invoices
export const getSupportInvoices: MiddlewareFn = async (req, res) => {
  const { companyId } = req.params;
  await requireSupportSession(req, companyId as string);
  const invoices = await Invoice.find({ company: companyId, isDeleted: { $ne: true } })
    .select("invoiceNumber client total status dueDate createdAt")
    .populate("client", "name")
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  res.status(StatusCodes.OK).json({
    success: true,
    data: invoices.map((i: any) => ({
      id: i._id.toString(), number: i.invoiceNumber, client: i.client?.name ?? null,
      total: i.total, status: i.status, dueDate: i.dueDate ?? null, createdAt: i.createdAt,
    })),
  });
};

// ─────────────────────────────────────────────────────────────────────────
// Data export & scheduled deletion
// ─────────────────────────────────────────────────────────────────────────

// Never exported: credentials, tokens, push endpoints.
const USER_EXPORT_FIELDS =
  "fullname email phone role isActive isVerified createdAt lastLogin company gender autoAcceptAssignments";

// POST /platform/companies/:companyId/export — JSON download of the company's data (GDPR access request)
export const exportCompanyData: MiddlewareFn = async (req, res) => {
  const { companyId } = req.params;
  const company = await loadCompany(
    companyId as string,
    "-stripeCustomerId -stripeSubscriptionId -emailSettings"
  );
  const { reason } = parseOrThrow(reasonSchema, req.body);
  const id = String(companyId);

  const [users, clients, sites, jobs, recurringJobs, quotes, invoices, timeOff] = await Promise.all([
    User.find({ company: id }).select(USER_EXPORT_FIELDS).lean(),
    Client.find({ company: id }).lean(),
    Site.find({ company: id }).lean(),
    Job.find({ company: id }).lean(),
    RecurringJob.find({ company: id }).lean(),
    Quote.find({ company: id }).lean(),
    Invoice.find({ company: id }).lean(),
    TimeOffRequest.find({ company: id }).lean(),
  ]);
  const assignments = await JobAssignment.find({ job: { $in: jobs.map(j => j._id) } }).lean();

  await recordPlatformAudit({
    req, actor: actorOf(req), action: "company.data.exported", targetType: "Company", targetId: id,
    company: id, reason,
    metadata: { counts: { users: users.length, clients: clients.length, jobs: jobs.length, assignments: assignments.length, invoices: invoices.length } },
    result: "success",
  });

  const fileName = `onclockly-export-${company.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.status(StatusCodes.OK).send(
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        company: company.toObject(),
        users, clients, sites, jobs, jobAssignments: assignments, recurringJobs, quotes, invoices, timeOffRequests: timeOff,
      },
      null,
      2
    )
  );
};

const scheduleDeletionSchema = reasonSchema.extend({ confirmName: z.string().trim() });

// POST /platform/companies/:companyId/deletion — disable now, delete after the grace period
export const scheduleCompanyDeletion: MiddlewareFn = async (req, res) => {
  const { companyId } = req.params;
  const company = await loadCompany(
    companyId as string,
    "name status deletionScheduledAt statusBeforeDeletion stripeSubscriptionId subscriptionStatus"
  );
  const { reason, confirmName } = parseOrThrow(scheduleDeletionSchema, req.body);
  if (confirmName !== company.name) throw new BadRequestError("Type the company name exactly to confirm.");
  if (company.deletionScheduledAt) throw new ConflictError("Deletion is already scheduled for this company.");
  if (hasLivePaidSubscription(company)) {
    throw new ConflictError("Cancel this company's paid subscription in Stripe before scheduling deletion.");
  }

  const before = { status: company.status ?? "active", deletionScheduledAt: null };
  company.statusBeforeDeletion = company.status ?? "active";
  company.status = "disabled";
  company.deletionScheduledAt = new Date(Date.now() + DELETION_GRACE_DAYS * DAY);
  await company.save();
  const after = { status: company.status, deletionScheduledAt: company.deletionScheduledAt };
  await recordPlatformAudit({
    req, actor: actorOf(req), action: "company.deletion.scheduled", targetType: "Company", targetId: companyId as string,
    company: companyId as string, reason, before, after, result: "success",
  });
  res.status(StatusCodes.OK).json({ success: true, msg: `Deletion scheduled for ${company.deletionScheduledAt.toISOString().slice(0, 10)}.`, ...after });
};

// DELETE /platform/companies/:companyId/deletion — cancel, restoring the previous status
export const cancelCompanyDeletion: MiddlewareFn = async (req, res) => {
  const { companyId } = req.params;
  const company = await loadCompany(companyId as string, "status deletionScheduledAt statusBeforeDeletion");
  const { reason } = parseOrThrow(reasonSchema, req.body);
  if (!company.deletionScheduledAt) throw new BadRequestError("No deletion is scheduled for this company.");
  const before = { status: company.status, deletionScheduledAt: company.deletionScheduledAt };
  company.status = (company.statusBeforeDeletion as any) || "active";
  company.deletionScheduledAt = null;
  company.statusBeforeDeletion = null;
  await company.save();
  const after = { status: company.status, deletionScheduledAt: null };
  await recordPlatformAudit({
    req, actor: actorOf(req), action: "company.deletion.cancelled", targetType: "Company", targetId: companyId as string,
    company: companyId as string, reason, before, after, result: "success",
  });
  res.status(StatusCodes.OK).json({ success: true, msg: "Deletion cancelled.", ...after });
};

// ─────────────────────────────────────────────────────────────────────────
// Users: recovery, security, notifications, move, anonymise
// ─────────────────────────────────────────────────────────────────────────

const auditUser = (
  req: Parameters<MiddlewareFn>[0],
  user: { _id: unknown; company?: unknown },
  action: Parameters<typeof recordPlatformAudit>[0]["action"],
  extra: { reason?: string | null; before?: unknown; after?: unknown; metadata?: unknown } = {}
) =>
  recordPlatformAudit({
    req, actor: actorOf(req), action, targetType: "User", targetId: String(user._id),
    company: user.company ? String(user.company) : null, result: "success", ...extra,
  });

// POST /platform/users/:userId/password-reset
export const sendUserPasswordReset: MiddlewareFn = async (req, res) => {
  const user = await loadUser(req.params.userId as string, "email fullname role company");
  const { reason } = parseOrThrow(reasonSchema, req.body);
  const { token, hash, expiresAt } = createPasswordResetToken();
  user.passwordResetToken = hash;
  user.passwordResetExpiresAt = expiresAt;
  await user.save();
  await sendPasswordResetEmail({ email: user.email, fullname: user.fullname, resetToken: token, isPortalAccount: user.role === "client" });
  await auditUser(req, user, "user.password_reset.sent", { reason });
  res.status(StatusCodes.OK).json({ success: true, msg: `Password reset link sent to ${user.email}.` });
};

// POST /platform/users/:userId/resend-verification
export const resendUserVerification: MiddlewareFn = async (req, res) => {
  const user = await loadUser(req.params.userId as string, "email fullname isVerified company");
  const { reason } = parseOrThrow(reasonSchema, req.body);
  if (user.isVerified) throw new BadRequestError("This email is already verified.");
  const { token, hash, expiresAt } = createEmailVerificationToken();
  user.emailVerificationToken = hash;
  user.emailVerificationExpiresAt = expiresAt;
  await user.save();
  await sendVerificationEmail({ email: user.email, fullname: user.fullname, verificationToken: token });
  await auditUser(req, user, "user.verification.resent", { reason });
  res.status(StatusCodes.OK).json({ success: true, msg: `Verification email sent to ${user.email}.` });
};

const changeEmailSchema = reasonSchema.extend({ email: z.string().trim().toLowerCase().email("Enter a valid email.") });

// PATCH /platform/users/:userId/email — sets the new address unverified and sends a verification link to it
export const changeUserEmail: MiddlewareFn = async (req, res) => {
  const user = await loadUser(req.params.userId as string, "email fullname company isVerified");
  const { email, reason } = parseOrThrow(changeEmailSchema, req.body);
  if (email === user.email) throw new BadRequestError("That's already this user's email.");
  if (await User.exists({ email, _id: { $ne: user._id } })) throw new ConflictError("Another account already uses that email.");
  const before = { email: user.email, isVerified: user.isVerified };
  const { token, hash, expiresAt } = createEmailVerificationToken();
  user.email = email;
  user.isVerified = false;
  user.emailVerificationToken = hash;
  user.emailVerificationExpiresAt = expiresAt;
  await user.save();
  sendVerificationEmail({ email, fullname: user.fullname, verificationToken: token }).catch(err =>
    console.error(`Failed to send verification email to ${email}:`, err)
  );
  await auditUser(req, user, "user.email.changed", { reason, before, after: { email, isVerified: false } });
  res.status(StatusCodes.OK).json({ success: true, msg: `Email changed. A verification link was sent to ${email}.`, email });
};

// POST /platform/users/:userId/sign-out-everywhere
// Clears every refresh session, so no device can renew its login. An access
// token already issued stays valid until it expires (≤15 min) — the same
// limitation documented on updateUserStatus.
export const revokeUserSessions: MiddlewareFn = async (req, res) => {
  const user = await loadUser(req.params.userId as string, "+sessions +refreshToken company");
  const { reason } = parseOrThrow(reasonSchema, req.body);
  const count = (user as any).sessions?.length ?? 0;
  (user as any).sessions = [];
  (user as any).refreshToken = undefined;
  (user as any).refreshTokenExpiresAt = undefined;
  await user.save();
  await auditUser(req, user, "user.sessions.revoked", { reason, metadata: { sessionsRevoked: count } });
  res.status(StatusCodes.OK).json({ success: true, msg: `Signed out of ${count} session${count === 1 ? "" : "s"}.`, revoked: count });
};

// POST /platform/users/:userId/test-notification — push to every registered device
export const sendUserTestNotification: MiddlewareFn = async (req, res) => {
  const user = await loadUser(req.params.userId as string, "pushSubscriptions expoPushTokens company");
  const web = user.pushSubscriptions?.length ?? 0;
  const mobile = user.expoPushTokens?.length ?? 0;
  if (!web && !mobile) throw new BadRequestError("This user has no devices registered for push notifications.");
  const payload = { title: "Test notification", body: "OnClockly support sent this to check your notifications are working.", tag: "platform-test", url: "/" };
  const results = await Promise.allSettled([sendPushToUser(String(user._id), payload), sendExpoPushToUser(String(user._id), payload)]);
  const failed = results.filter(r => r.status === "rejected").length;
  await auditUser(req, user, "user.test_notification.sent", { metadata: { web, mobile, failed } });
  res.status(StatusCodes.OK).json({
    success: true,
    msg: failed ? "Sent, but one channel reported an error — check Platform → Errors." : `Sent to ${web} browser and ${mobile} mobile device${web + mobile === 1 ? "" : "s"}.`,
    web, mobile,
  });
};

const moveCompanySchema = reasonSchema.extend({ companyId: z.string() });

// PATCH /platform/users/:userId/company — fixes a user who joined the wrong company.
// Their past assignments stay with the old company's jobs (history isn't rewritten).
export const moveUserCompany: MiddlewareFn = async (req, res) => {
  const user = await loadUser(req.params.userId as string, "company role platformRole email");
  const { companyId, reason } = parseOrThrow(moveCompanySchema, req.body);
  requireObjectId(companyId, "company id");
  if (user.role === "owner" || (await Company.exists({ owner: user._id }))) {
    throw new ConflictError("This user owns a company — transfer ownership before moving them.");
  }
  if (user.company && String(user.company) === companyId) throw new BadRequestError("The user is already in that company.");
  const target = await Company.findById(companyId).select("name status");
  if (!target) throw new NotFoundError("Target company not found.");
  const before = { company: user.company ? String(user.company) : null };
  user.company = target._id as any;
  await user.save();
  await recordPlatformAudit({
    req, actor: actorOf(req), action: "user.company.moved", targetType: "User", targetId: String(user._id),
    company: companyId, reason, before, after: { company: companyId }, result: "success",
  });
  res.status(StatusCodes.OK).json({ success: true, msg: `Moved to ${target.name}.`, company: { id: companyId, name: target.name } });
};

const anonymiseSchema = reasonSchema.extend({ confirmEmail: z.string().trim().toLowerCase() });

// POST /platform/users/:userId/anonymise — GDPR erasure that keeps payroll history
// Personal details are wiped and the account disabled; their shifts and
// timesheets stay, shown as "Former worker". Irreversible.
export const anonymiseUser: MiddlewareFn = async (req, res) => {
  const user = await loadUser(req.params.userId as string, "+sessions +refreshToken email fullname role platformRole company");
  const { reason, confirmEmail } = parseOrThrow(anonymiseSchema, req.body);
  if (confirmEmail !== user.email) throw new BadRequestError("Type the user's email exactly to confirm.");
  if (user.platformRole) throw new ConflictError("Revoke this user's platform access before anonymising them.");
  if (user.role === "owner" || (await Company.exists({ owner: user._id }))) {
    throw new ConflictError("This user owns a company — transfer ownership or schedule the company's deletion instead.");
  }
  const before = { email: user.email, fullname: user.fullname };
  const placeholder = user.role === "worker" ? "Former worker" : "Former user";
  const u = user as any;
  u.fullname = placeholder;
  u.email = `deleted-${user._id}@deleted.onclockly.invalid`;
  u.phone = undefined;
  u.gender = undefined;
  u.profilePhoto = null;
  u.documents = [];
  u.pushSubscriptions = [];
  u.expoPushTokens = [];
  u.clientPushTokens = [];
  u.sessions = [];
  u.refreshToken = undefined;
  u.isActive = false;
  u.isVerified = false;
  u.deletionRequestedAt = u.deletionRequestedAt ?? new Date();
  await user.save();
  await JobAssignment.updateMany({ worker: user._id }, { $set: { fullname: placeholder } });
  await auditUser(req, user, "user.anonymised", { reason, before, after: { fullname: placeholder } });
  res.status(StatusCodes.OK).json({ success: true, msg: "User anonymised." });
};
