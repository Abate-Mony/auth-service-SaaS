import { StatusCodes } from "http-status-codes";
import mongoose from "mongoose";
import { z } from "zod";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import UserRestrictionModel, { RESTRICTABLE_ACTIONS } from "../models/userRestrictionModel.js";
import userModel from "../models/userModel.js";
import {
    sendAppealResponseEmail,
    sendAppealSubmittedEmail,
    sendRestrictionLiftedEmail,
    sendRestrictionNotice,
} from "../utils/mailTemplates.js";

const RESTRICTION_REASONS = ["document_expired", "disciplinary", "no_show", "left_company", "other"] as const;
const ACCESS_LEVELS = ["none", "read_only", "limited"] as const;
const REMEDIES = ["upload_document", "contact_manager", "appeal", "none"] as const;

const objectIdString = z.string().refine(v => mongoose.Types.ObjectId.isValid(v), "Invalid id.");

// Only `user`, `reason` and `message` are required — everything else has a
// sensible model default. `company` and `restrictedBy` are never accepted
// from the body; they're always set server-side from req.user.
const createRestrictionSchema = z
    .object({
        user: objectIdString,
        reason: z.enum(RESTRICTION_REASONS),
        message: z.string().trim().min(1, "A message for the user is required").max(2000),
        accessLevel: z.enum(ACCESS_LEVELS).optional(),
        restrictions: z.array(z.enum(RESTRICTABLE_ACTIONS)).optional(),
        remedy: z.enum(REMEDIES).optional(),
        canAppeal: z.boolean().optional(),
        expiresAt: z.string().trim().min(1).optional(),
        internalNote: z.string().trim().max(3000).optional(),
    })
    .strict();

// user, company, reason and restrictedBy are deliberately not editable here —
// if the reason changed, that's a new restriction, not an edit to this one.
const updateRestrictionSchema = z
    .object({
        message: z.string().trim().min(1).max(2000).optional(),
        internalNote: z.string().trim().max(3000).optional(),
        accessLevel: z.enum(ACCESS_LEVELS).optional(),
        restrictions: z.array(z.enum(RESTRICTABLE_ACTIONS)).optional(),
        remedy: z.enum(REMEDIES).optional(),
        canAppeal: z.boolean().optional(),
        expiresAt: z.union([z.string().trim().min(1), z.null()]).optional(),
    })
    .strict();

const liftSchema = z.object({ liftReason: z.string().trim().max(1000).optional() }).strict();

const appealSubmitSchema = z
    .object({ message: z.string().trim().min(1, "Appeal message is required").max(3000) })
    .strict();

const appealResponseSchema = z
    .object({
        status: z.enum(["accepted", "rejected"]),
        response: z.string().trim().min(1, "A response message is required").max(3000),
    })
    .strict();

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

const RESTRICTION_POPULATE = [
    { path: "user", select: "fullname email role" },
    { path: "restrictedBy", select: "fullname" },
    { path: "liftedBy", select: "fullname" },
];

// POST /restrictions
export const createRestriction: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(createRestrictionSchema, req.body);
    const companyId = req.user.company_id;

    if (data.user === req.user.user_id.toString()) {
        throw new BadRequestError("You cannot restrict yourself.");
    }

    const targetUser = await userModel.findOne({ _id: data.user, company: companyId }).select("role email fullname");
    if (!targetUser) throw new NotFoundError("User not found.");
    if (targetUser.role === "admin") {
        throw new BadRequestError("Admins cannot be restricted.");
    }

    const expiresAt = data.expiresAt ? new Date(data.expiresAt) : undefined;

    let restriction;
    try {
        restriction = await UserRestrictionModel.create({
            company: companyId,
            user: data.user,
            reason: data.reason,
            message: data.message,
            internalNote: data.internalNote,
            accessLevel: data.accessLevel,
            restrictions: data.restrictions,
            remedy: data.remedy,
            canAppeal: data.canAppeal,
            expiresAt,
            restrictedBy: req.user.user_id,
        });
    } catch (err: any) {
        if (err?.code === 11000) {
            throw new BadRequestError(
                "This worker already has an active restriction. Lift it first, or edit the existing one."
            );
        }
        // The model's pre("validate")/pre("save") guards — mid-shift clock-out,
        // "limited" with no restrictions listed, bad expiry ordering — throw a
        // plain Error whose message is already safe to show the caller, and
        // create() has no other realistic failure mode here.
        throw new BadRequestError(err.message);
    }

    sendRestrictionNotice({
        email: targetUser.email,
        fullname: targetUser.fullname,
        reason: restriction.reason,
        message: restriction.message,
        remedy: restriction.remedy,
        canAppeal: restriction.canAppeal,
    }).catch(err => console.error("Failed to send restriction notice email:", err));

    res.status(StatusCodes.CREATED).json({ success: true, restriction });
};

// GET /restrictions
export const getRestrictions: MiddlewareFn = async (req, res) => {
    const {
        status = "active",
        reason,
        hasAppeal,
        page = "1",
        limit = "20",
    } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const match: Record<string, any> = { company: req.user.company_id };
    if (status && status !== "all") match.status = status;
    if (reason) match.reason = reason;
    if (hasAppeal === "true") match["appeal.status"] = { $exists: true };
    if (hasAppeal === "false") match["appeal.status"] = { $exists: false };

    const [restrictions, total] = await Promise.all([
        UserRestrictionModel.find(match)
            .populate(RESTRICTION_POPULATE)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNum)
            .lean(),
        UserRestrictionModel.countDocuments(match),
    ]);

    res.status(StatusCodes.OK).json({
        success: true,
        restrictions,
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
    });
};

// GET /restrictions/:id
export const getRestriction: MiddlewareFn = async (req, res) => {
    const restriction = await UserRestrictionModel.findOne({ _id: req.params.id, company: req.user.company_id })
        .populate(RESTRICTION_POPULATE)
        .populate({ path: "appeal.respondedBy", select: "fullname" });
    if (!restriction) throw new NotFoundError("Restriction not found.");

    res.status(StatusCodes.OK).json({ success: true, restriction });
};

// GET /restrictions/me — any authenticated user. Relies on loadRestriction
// having already run (and self-healed expiry) for req.restriction.
export const getMyRestriction: MiddlewareFn = async (req, res) => {
    if (!req.restriction) {
        res.status(StatusCodes.OK).json({ success: true, restriction: null });
        return;
    }

    res.status(StatusCodes.OK).json({ success: true, restriction: req.restriction.toUserFacing() });
};

// PATCH /restrictions/:id
export const updateRestriction: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(updateRestrictionSchema, req.body);
    if (Object.keys(data).length === 0) {
        throw new BadRequestError("No valid fields provided.");
    }

    const restriction = await UserRestrictionModel.findOne({ _id: req.params.id, company: req.user.company_id });
    if (!restriction) throw new NotFoundError("Restriction not found.");

    if (data.message !== undefined) restriction.message = data.message;
    if (data.internalNote !== undefined) restriction.internalNote = data.internalNote;
    if (data.accessLevel !== undefined) restriction.accessLevel = data.accessLevel;
    if (data.restrictions !== undefined) restriction.restrictions = data.restrictions;
    if (data.remedy !== undefined) restriction.remedy = data.remedy;
    if (data.canAppeal !== undefined) restriction.canAppeal = data.canAppeal;
    if (data.expiresAt !== undefined) {
        restriction.expiresAt = data.expiresAt ? new Date(data.expiresAt) : undefined;
    }

    try {
        // .save(), not findOneAndUpdate — so the pre("validate")/pre("save")
        // guards (mid-shift clock-out, "limited" with an empty list) still run
        // when a restriction is edited into one of those shapes, not just created.
        await restriction.save();
    } catch (err: any) {
        throw new BadRequestError(err.message);
    }

    res.status(StatusCodes.OK).json({ success: true, restriction });
};

// PATCH /restrictions/:id/lift
export const liftRestriction: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(liftSchema, req.body);

    const restriction = await UserRestrictionModel.findOne({
        _id: req.params.id,
        company: req.user.company_id,
    }).populate<{ user: { _id: mongoose.Types.ObjectId; email: string; fullname: string } }>(
        "user",
        "email fullname"
    );
    if (!restriction) throw new NotFoundError("Restriction not found.");
    if (restriction.status !== "active") {
        throw new BadRequestError(`This restriction is already ${restriction.status}.`);
    }

    restriction.status = "lifted";
    restriction.liftedAt = new Date();
    restriction.liftedBy = req.user.user_id as any;
    if (data.liftReason) restriction.liftReason = data.liftReason;
    await restriction.save();

    if (restriction.user?.email) {
        sendRestrictionLiftedEmail({
            email: restriction.user.email,
            fullname: restriction.user.fullname,
            liftReason: data.liftReason,
        }).catch(err => console.error("Failed to send restriction-lifted email:", err));
    }

    res.status(StatusCodes.OK).json({ success: true, restriction });
};

// POST /restrictions/me/appeal — the restricted user themselves.
export const submitAppeal: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(appealSubmitSchema, req.body);

    const restriction = req.restriction;
    if (!restriction) throw new BadRequestError("You don't have an active restriction to appeal.");
    if (!restriction.canAppeal) throw new BadRequestError("This restriction can't be appealed.");
    if (restriction.appeal?.submittedAt) {
        throw new BadRequestError("An appeal has already been submitted for this restriction.");
    }

    restriction.appeal = {
        submittedAt: new Date(),
        message: data.message,
        status: "pending",
    } as any;
    await restriction.save();

    const [manager, worker] = await Promise.all([
        userModel.findById(restriction.restrictedBy).select("email"),
        userModel.findById(restriction.user).select("fullname"),
    ]);
    if (manager?.email) {
        sendAppealSubmittedEmail({
            managerEmail: manager.email,
            workerFullname: worker?.fullname ?? "A worker",
            appealMessage: data.message,
        }).catch(err => console.error("Failed to notify manager of appeal:", err));
    }

    res.status(StatusCodes.OK).json({ success: true, restriction: restriction.toUserFacing() });
};

// PATCH /restrictions/:id/appeal
export const respondToAppeal: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(appealResponseSchema, req.body);

    const restriction = await UserRestrictionModel.findOne({
        _id: req.params.id,
        company: req.user.company_id,
    }).populate<{ user: { _id: mongoose.Types.ObjectId; email: string; fullname: string } }>(
        "user",
        "email fullname"
    );
    if (!restriction) throw new NotFoundError("Restriction not found.");
    if (!restriction.appeal?.submittedAt) {
        throw new BadRequestError("This restriction has no appeal to respond to.");
    }
    if (restriction.appeal.status !== "pending") {
        throw new BadRequestError(`This appeal has already been ${restriction.appeal.status}.`);
    }

    restriction.appeal.respondedAt = new Date();
    restriction.appeal.respondedBy = req.user.user_id as any;
    restriction.appeal.response = data.response;
    restriction.appeal.status = data.status;

    if (data.status === "accepted") {
        restriction.status = "lifted";
        restriction.liftedAt = new Date();
        restriction.liftedBy = req.user.user_id as any;
        restriction.liftReason = "Appeal accepted";
    }

    await restriction.save();

    if (restriction.user?.email) {
        sendAppealResponseEmail({
            email: restriction.user.email,
            fullname: restriction.user.fullname,
            status: data.status,
            response: data.response,
        }).catch(err => console.error("Failed to send appeal-response email:", err));
    }

    res.status(StatusCodes.OK).json({ success: true, restriction });
};
