// controllers/leadController.ts
//
// Leads live in the same Client collection as real clients — see
// clientModel.ts's "Lifecycle" section. This controller only ever touches
// records where lifecycle is "lead" (or "lost", for the dedicated lost
// routes); clientController.ts owns lifecycle:"client" records, and the
// two are never meant to overlap. See INPRN_LEADS_SERVER_IMPLEMENTATION.md
// for the full spec this was built against.
import { StatusCodes } from "http-status-codes";
import mongoose from "mongoose";
import { z } from "zod";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { MiddlewareFn, getReqUser } from "../interfaces/expresstype.js";
import Client from "../models/clientModel.js";
import Quote from "../models/quoteModel.js";
import User from "../models/userModel.js";
import { formatAddress } from "../utils/formatAddress.js";
import { convertLeadToClient } from "../services/leadConversionService.js";
import dayjs from "../utils/dayjsSetup.js";
import { TZ } from "../utils/dates.js";

const LEAD_STAGES = ["new", "contacted", "call_booked", "quote_sent", "negotiating"] as const;
const LEAD_SOURCES = ["website_quote", "phone", "email", "referral", "walk_in", "other"] as const;

// Same escaping precedent as clientController/quoteController's search.
const escapeRegExp = (input: string): string => input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseOrThrow = <T>(schema: z.ZodSchema<T>, body: unknown): T => {
    try {
        return schema.parse(body);
    } catch (err) {
        if (err instanceof z.ZodError) {
            const message = err.issues
                .map(issue => `${issue.path.join(".") || "value"}: ${issue.message}`)
                .join("; ");
            throw new BadRequestError(message);
        }
        throw err;
    }
};

// Shared by createLead's defaulting and updateLead's partial — one place
// a stage/source typo gets caught instead of two.
const contactSchema = z.object({
    name: z.string().trim().optional(),
    role: z.string().trim().optional(),
    email: z.union([z.string().trim().email(), z.literal("")]).optional(),
    phone: z.string().trim().optional(),
    isPrimary: z.boolean().optional(),
});

const addressSchema = z.object({
    line1: z.string().trim().optional(),
    line2: z.string().trim().optional(),
    city: z.string().trim().optional(),
    county: z.string().trim().optional(),
    postcode: z.string().trim().optional(),
    country: z.string().trim().optional(),
});

const createLeadSchema = z
    .object({
        name: z.string().trim().min(1, "Lead name is required").max(150),
        contacts: z.array(contactSchema).optional(),
        phone: z.string().trim().optional(),
        billingEmail: z.union([z.string().trim().email(), z.literal("")]).optional(),
        address: addressSchema.optional(),
        leadSource: z.enum(LEAD_SOURCES).optional(),
        leadStage: z.enum(LEAD_STAGES).optional(),
        nextFollowUpAt: z.string().datetime().nullable().optional(),
        assignedTo: z.string().nullable().optional(),
        estimatedValue: z.number().min(0).optional(),
        notes: z.string().trim().max(2000).optional(),
    })
    .strict();

// PATCH /leads/:id — deliberately its own schema, not createLeadSchema.partial():
// company/createdBy/lifecycle/convertedAt/lostAt/isDeleted must never be
// reachable from this route even if someone adds a field to createLeadSchema
// later and forgets this one.
const updateLeadSchema = z
    .object({
        name: z.string().trim().min(1).max(150).optional(),
        contacts: z.array(contactSchema).optional(),
        phone: z.string().trim().optional(),
        billingEmail: z.union([z.string().trim().email(), z.literal("")]).optional(),
        vatNumber: z.string().trim().optional(),
        address: addressSchema.optional(),
        leadStage: z.enum(LEAD_STAGES).optional(),
        leadSource: z.enum(LEAD_SOURCES).optional(),
        nextFollowUpAt: z.string().datetime().nullable().optional(),
        lastContactedAt: z.string().datetime().nullable().optional(),
        assignedTo: z.string().nullable().optional(),
        estimatedValue: z.number().min(0).optional(),
        notes: z.string().trim().max(2000).optional(),
    })
    .strict();

const stageSchema = z.object({ stage: z.enum(LEAD_STAGES) }).strict();
const assignSchema = z.object({ assignedTo: z.string().nullable() }).strict();
const followUpSchema = z.object({ nextFollowUpAt: z.string().datetime().nullable() }).strict();
const lostSchema = z.object({ reason: z.string().trim().max(500).optional() }).strict();
const convertSchema = z
    .object({
        defaultChargeType: z.enum(["hourly", "fixed"]).optional(),
        defaultChargeRate: z.number().min(0).optional(),
        paymentTermsDays: z.number().int().min(0).optional(),
        billingFrequency: z.enum(["per_job", "weekly", "fortnightly", "monthly", "manual"]).optional(),
        billingDayOfWeek: z.number().int().min(0).max(6).optional(),
        billingDayOfMonth: z.number().int().min(1).max(31).optional(),
    })
    .strict();

const serializeLead = (lead: Record<string, any>) => ({
    ...lead,
    formattedAddress: formatAddress(lead.address),
    primaryContact: (lead.contacts ?? []).find((c: any) => c.isPrimary) ?? lead.contacts?.[0] ?? null,
});

// assignedTo must be a real, same-company admin/manager — never trusted
// blind, same reasoning as every other cross-collection id in this codebase.
// Sales ownership is an admin/manager concept here; workers don't get leads.
// Callers only invoke this once they've already confirmed assignedTo isn't
// undefined ("leave as-is") — null ("clear it") is the only other no-lookup case.
async function resolveAssignee(
    assignedTo: string | null,
    companyId: mongoose.Types.ObjectId
): Promise<mongoose.Types.ObjectId | null> {
    if (assignedTo === null) return null;
    if (!mongoose.Types.ObjectId.isValid(assignedTo)) {
        throw new BadRequestError("Invalid assignedTo id.");
    }
    const user = await User.findOne({
        _id: assignedTo,
        company: companyId,
        role: { $in: ["admin", "manager"] },
        isActive: true,
    }).select("_id");
    if (!user) {
        throw new BadRequestError("assignedTo must be an active admin or manager in this company.");
    }
    return user._id as mongoose.Types.ObjectId;
}

// ─────────────────────────────────────────────
// GET /leads
// ─────────────────────────────────────────────
export const getAllLeads: MiddlewareFn = async (req, res) => {
    const {
        search, stage, source, assignedTo, followUp,
        createdFrom, createdTo, page = "1", limit = "20",
    } = req.query as Record<string, string | undefined>;

    const pageNum = Math.max(1, parseInt(page ?? "1", 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit ?? "20", 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const companyId = new mongoose.Types.ObjectId(getReqUser(req).company_id.toString());
    // No explicit status filter — the model's own pre("validate") hook
    // forces status:"active" whenever lifecycle is "lead", so every open
    // lead is active by construction.
    const match: Record<string, any> = { company: companyId, lifecycle: "lead", isDeleted: false };

    if (stage && LEAD_STAGES.includes(stage as any)) match.leadStage = stage;
    if (source && LEAD_SOURCES.includes(source as any)) match.leadSource = source;

    if (assignedTo) {
        if (assignedTo === "unassigned") {
            match.assignedTo = null;
        } else if (mongoose.Types.ObjectId.isValid(assignedTo)) {
            match.assignedTo = new mongoose.Types.ObjectId(assignedTo);
        }
    }

    if (followUp) {
        const now = dayjs().tz(TZ);
        if (followUp === "overdue") {
            match.nextFollowUpAt = { $lt: now.toDate() };
        } else if (followUp === "today") {
            match.nextFollowUpAt = { $gte: now.startOf("day").toDate(), $lt: now.endOf("day").toDate() };
        } else if (followUp === "this_week") {
            match.nextFollowUpAt = { $gte: now.startOf("week").toDate(), $lt: now.endOf("week").toDate() };
        } else if (followUp === "none") {
            match.nextFollowUpAt = null;
        }
    }

    if (createdFrom || createdTo) {
        match.createdAt = {};
        if (createdFrom) match.createdAt.$gte = new Date(createdFrom);
        if (createdTo) match.createdAt.$lte = new Date(createdTo);
    }

    if (search?.trim()) {
        const safe = escapeRegExp(search.trim());
        match.$or = [
            { name: { $regex: safe, $options: "i" } },
            { billingEmail: { $regex: safe, $options: "i" } },
            { phone: { $regex: safe, $options: "i" } },
            { "contacts.name": { $regex: safe, $options: "i" } },
            { "contacts.email": { $regex: safe, $options: "i" } },
            { "contacts.phone": { $regex: safe, $options: "i" } },
        ];
    }

    const [leads, total] = await Promise.all([
        Client.find(match)
            .populate("assignedTo", "fullname email")
            .populate("createdBy", "fullname email")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNum)
            .lean({ virtuals: true }),
        Client.countDocuments(match),
    ]);

    res.status(StatusCodes.OK).json({
        success: true,
        leads: leads.map(serializeLead),
        pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
    });
};

// ─────────────────────────────────────────────
// GET /leads/summary
// ─────────────────────────────────────────────
export const getLeadSummary: MiddlewareFn = async (req, res) => {
    const companyId = new mongoose.Types.ObjectId(getReqUser(req).company_id.toString());
    const now = dayjs().tz(TZ);
    const monthStart = now.startOf("month").toDate();

    const [openLeads, overdueFollowUps, quotesSent, negotiating, convertedThisMonth, pipelineAgg] = await Promise.all([
        Client.countDocuments({ company: companyId, lifecycle: "lead", isDeleted: false }),
        Client.countDocuments({
            company: companyId, lifecycle: "lead", isDeleted: false,
            nextFollowUpAt: { $lt: now.toDate() },
        }),
        Client.countDocuments({ company: companyId, lifecycle: "lead", isDeleted: false, leadStage: "quote_sent" }),
        Client.countDocuments({ company: companyId, lifecycle: "lead", isDeleted: false, leadStage: "negotiating" }),
        Client.countDocuments({
            company: companyId, lifecycle: "client", isDeleted: false,
            convertedAt: { $gte: monthStart },
        }),
        Client.aggregate([
            { $match: { company: companyId, lifecycle: "lead", isDeleted: false } },
            { $group: { _id: null, total: { $sum: "$estimatedValue" } } },
        ]),
    ]);

    res.status(StatusCodes.OK).json({
        success: true,
        summary: {
            openLeads,
            overdueFollowUps,
            quotesSent,
            negotiating,
            convertedThisMonth,
            estimatedPipelineValue: pipelineAgg[0]?.total ?? 0,
        },
    });
};

// ─────────────────────────────────────────────
// GET /leads/lost
// ─────────────────────────────────────────────
export const getLostLeads: MiddlewareFn = async (req, res) => {
    const { page = "1", limit = "20" } = req.query as Record<string, string | undefined>;
    const pageNum = Math.max(1, parseInt(page ?? "1", 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit ?? "20", 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const companyId = new mongoose.Types.ObjectId(getReqUser(req).company_id.toString());
    const match: Record<string, any> = { company: companyId, lifecycle: "lost", isDeleted: false };

    const [leads, total] = await Promise.all([
        Client.find(match)
            .populate("assignedTo", "fullname email")
            .sort({ lostAt: -1 })
            .skip(skip)
            .limit(limitNum)
            .lean({ virtuals: true }),
        Client.countDocuments(match),
    ]);

    res.status(StatusCodes.OK).json({
        success: true,
        leads: leads.map(serializeLead),
        pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
    });
};

// ─────────────────────────────────────────────
// GET /leads/converted
// ─────────────────────────────────────────────
export const getConvertedLeads: MiddlewareFn = async (req, res) => {
    const { page = "1", limit = "20" } = req.query as Record<string, string | undefined>;
    const pageNum = Math.max(1, parseInt(page ?? "1", 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit ?? "20", 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const companyId = new mongoose.Types.ObjectId(getReqUser(req).company_id.toString());
    const match: Record<string, any> = { company: companyId, lifecycle: "client", isDeleted: false, convertedAt: { $ne: null } };

    const [leads, total] = await Promise.all([
        Client.find(match).sort({ convertedAt: -1 }).skip(skip).limit(limitNum).lean({ virtuals: true }),
        Client.countDocuments(match),
    ]);

    res.status(StatusCodes.OK).json({
        success: true,
        leads: leads.map(serializeLead),
        pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
    });
};

// ─────────────────────────────────────────────
// POST /leads
// ─────────────────────────────────────────────
export const createLead: MiddlewareFn = async (req, res) => {
    const user = getReqUser(req);
    const data = parseOrThrow(createLeadSchema, req.body);
    const companyId = new mongoose.Types.ObjectId(user.company_id.toString());

    const assignedTo = data.assignedTo === undefined ? undefined : await resolveAssignee(data.assignedTo, companyId);

    let lead;
    try {
        lead = await Client.create({
            ...data,
            nextFollowUpAt: data.nextFollowUpAt ? new Date(data.nextFollowUpAt) : undefined,
            assignedTo,
            lifecycle: "lead",
            company: companyId,
            createdBy: user.user_id,
        });
    } catch (err: any) {
        // The name-uniqueness index only applies to lifecycle:"client", so
        // this can't actually fire for a lead today — guarded anyway in
        // case that index's scope ever changes.
        if (err?.code === 11000) throw new BadRequestError(`A record called "${data.name}" already exists.`);
        throw err;
    }

    res.status(StatusCodes.CREATED).json({
        success: true,
        message: "Lead created successfully",
        lead: serializeLead(lead.toObject({ virtuals: true })),
    });
};

// Shared company+lifecycle scoping for every single-lead route below.
async function findLead(
    id: string,
    companyId: mongoose.Types.ObjectId,
    lifecycle: "lead" | "lost" | Array<"lead" | "lost">
) {
    if (!mongoose.Types.ObjectId.isValid(id)) throw new NotFoundError("Lead not found.");
    const lifecycleFilter = Array.isArray(lifecycle) ? { $in: lifecycle } : lifecycle;
    const lead = await Client.findOne({ _id: id, company: companyId, lifecycle: lifecycleFilter, isDeleted: false });
    if (!lead) throw new NotFoundError("Lead not found.");
    return lead;
}

// ─────────────────────────────────────────────
// GET /leads/:id
// ─────────────────────────────────────────────
export const getLead: MiddlewareFn = async (req, res) => {
    const companyId = new mongoose.Types.ObjectId(getReqUser(req).company_id.toString());
    const lead = await findLead(req.params.id as string, companyId, ["lead", "lost"]);

    const populated = await lead.populate([
        { path: "assignedTo", select: "fullname email" },
        { path: "createdBy", select: "fullname email" },
        { path: "lifecycleHistory.by", select: "fullname email" },
    ]);

    const quotes = await Quote.find({ client: lead._id, company: companyId, isDeleted: false })
        .select("quoteNumber title status total currency validUntil sentAt acceptedAt declinedAt createdAt")
        .sort({ createdAt: -1 })
        .lean();

    res.status(StatusCodes.OK).json({
        success: true,
        lead: serializeLead(populated.toObject({ virtuals: true })),
        quotes,
    });
};

// ─────────────────────────────────────────────
// PATCH /leads/:id
// ─────────────────────────────────────────────
export const updateLead: MiddlewareFn = async (req, res) => {
    const companyId = new mongoose.Types.ObjectId(getReqUser(req).company_id.toString());
    const data = parseOrThrow(updateLeadSchema, req.body);
    if (Object.keys(data).length === 0) throw new BadRequestError("No valid fields provided.");

    const lead = await findLead(req.params.id as string, companyId, "lead");

    const { assignedTo, nextFollowUpAt, lastContactedAt, ...rest } = data;
    Object.assign(lead, rest);
    if (assignedTo !== undefined) lead.assignedTo = await resolveAssignee(assignedTo, companyId) as any;
    if (nextFollowUpAt !== undefined) lead.nextFollowUpAt = nextFollowUpAt ? new Date(nextFollowUpAt) : null;
    if (lastContactedAt !== undefined) lead.lastContactedAt = lastContactedAt ? new Date(lastContactedAt) : null;

    await lead.save();

    res.status(StatusCodes.OK).json({
        success: true,
        lead: serializeLead(lead.toObject({ virtuals: true })),
    });
};

// ─────────────────────────────────────────────
// PATCH /leads/:id/stage
// ─────────────────────────────────────────────
export const changeLeadStage: MiddlewareFn = async (req, res) => {
    const companyId = new mongoose.Types.ObjectId(getReqUser(req).company_id.toString());
    const { stage } = parseOrThrow(stageSchema, req.body);

    const lead = await findLead(req.params.id as string, companyId, "lead");
    lead.leadStage = stage;
    if (stage === "contacted") lead.lastContactedAt = new Date();
    await lead.save();

    res.status(StatusCodes.OK).json({ success: true, lead: serializeLead(lead.toObject({ virtuals: true })) });
};

// ─────────────────────────────────────────────
// PATCH /leads/:id/assign
// ─────────────────────────────────────────────
export const assignLead: MiddlewareFn = async (req, res) => {
    const companyId = new mongoose.Types.ObjectId(getReqUser(req).company_id.toString());
    const { assignedTo } = parseOrThrow(assignSchema, req.body);

    const lead = await findLead(req.params.id as string, companyId, "lead");
    lead.assignedTo = await resolveAssignee(assignedTo, companyId) as any;
    await lead.save();

    res.status(StatusCodes.OK).json({ success: true, lead: serializeLead(lead.toObject({ virtuals: true })) });
};

// ─────────────────────────────────────────────
// PATCH /leads/:id/follow-up
// ─────────────────────────────────────────────
export const updateFollowUp: MiddlewareFn = async (req, res) => {
    const companyId = new mongoose.Types.ObjectId(getReqUser(req).company_id.toString());
    const { nextFollowUpAt } = parseOrThrow(followUpSchema, req.body);

    const lead = await findLead(req.params.id as string, companyId, "lead");
    lead.nextFollowUpAt = nextFollowUpAt ? new Date(nextFollowUpAt) : null;
    await lead.save();

    res.status(StatusCodes.OK).json({ success: true, lead: serializeLead(lead.toObject({ virtuals: true })) });
};

// ─────────────────────────────────────────────
// PATCH /leads/:id/contacted
// ─────────────────────────────────────────────
export const markContacted: MiddlewareFn = async (req, res) => {
    const companyId = new mongoose.Types.ObjectId(getReqUser(req).company_id.toString());
    const lead = await findLead(req.params.id as string, companyId, "lead");

    lead.lastContactedAt = new Date();
    // Only ever advances — never regresses a lead already past "contacted"
    // (e.g. quote_sent, negotiating) just because someone logged a call.
    if (lead.leadStage === "new") lead.leadStage = "contacted";
    await lead.save();

    res.status(StatusCodes.OK).json({ success: true, lead: serializeLead(lead.toObject({ virtuals: true })) });
};

// ─────────────────────────────────────────────
// POST /leads/:id/convert
// ─────────────────────────────────────────────
export const convertLead: MiddlewareFn = async (req, res) => {
    const user = getReqUser(req);
    const companyId = new mongoose.Types.ObjectId(user.company_id.toString());
    const options = parseOrThrow(convertSchema, req.body);

    const lead = await findLead(req.params.id as string, companyId, "lead");
    const client = await convertLeadToClient(lead, { ...options, actorId: user.user_id.toString() });

    res.status(StatusCodes.OK).json({
        success: true,
        message: "Lead converted to client successfully",
        client: serializeLead(client.toObject({ virtuals: true })),
    });
};

// ─────────────────────────────────────────────
// POST /leads/:id/lost
// ─────────────────────────────────────────────
export const markLeadLost: MiddlewareFn = async (req, res) => {
    const user = getReqUser(req);
    const companyId = new mongoose.Types.ObjectId(user.company_id.toString());
    const { reason } = parseOrThrow(lostSchema, req.body);

    const lead = await findLead(req.params.id as string, companyId, "lead");
    (lead as any).$locals.actorId = user.user_id.toString();
    lead.lifecycle = "lost";
    lead.lostReason = reason ?? "";
    await lead.save();

    res.status(StatusCodes.OK).json({ success: true, lead: serializeLead(lead.toObject({ virtuals: true })) });
};

// ─────────────────────────────────────────────
// POST /leads/:id/restore
// ─────────────────────────────────────────────
export const restoreLead: MiddlewareFn = async (req, res) => {
    const user = getReqUser(req);
    const companyId = new mongoose.Types.ObjectId(user.company_id.toString());

    const lead = await findLead(req.params.id as string, companyId, "lost");
    (lead as any).$locals.actorId = user.user_id.toString();
    lead.lifecycle = "lead";
    lead.leadStage = "new";
    await lead.save();

    res.status(StatusCodes.OK).json({ success: true, lead: serializeLead(lead.toObject({ virtuals: true })) });
};

// ─────────────────────────────────────────────
// DELETE /leads/:id — soft delete/archive, never a hard delete.
// ─────────────────────────────────────────────
export const archiveLead: MiddlewareFn = async (req, res) => {
    const companyId = new mongoose.Types.ObjectId(getReqUser(req).company_id.toString());
    const lead = await findLead(req.params.id as string, companyId, ["lead", "lost"]);

    lead.isDeleted = true;
    await lead.save();

    res.status(StatusCodes.OK).json({ success: true, message: "Lead archived." });
};
