import { StatusCodes } from "http-status-codes";
import mongoose from "mongoose";
import {
    BadRequestError,
    ConflictError,
    NotFoundError,
    UnauthenticatedError,
    UnauthorizedError,
} from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import Invitation, { InvitationRole } from "../models/invitationModel.js";
import User from "../models/userModel.js";
import Company from "../models/company.js";
import NotificationPreferenceModel from "../models/NotificationPreferenceModel.js";
import { hashPassword } from "../utils/passwordUtils.js";
import { createInvitationToken, hashInvitationToken, sanitizeUser } from "../utils/tokenUtils.js";
import { sendInvitationEmail } from "../utils/mailTemplates.js";
import { issueTokens } from "./authControler.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITATION_ROLES: InvitationRole[] = ["worker", "manager"];

const normalizeEmail = (email: unknown): string => {
    if (typeof email !== "string" || !email.trim()) {
        throw new BadRequestError("Email is required.", "INVITATION_INVALID");
    }
    const normalized = email.trim().toLowerCase();
    if (!EMAIL_RE.test(normalized)) {
        throw new BadRequestError("Enter a valid email address.", "INVITATION_INVALID");
    }
    return normalized;
};

const validateRole = (role: unknown): InvitationRole => {
    if (!INVITATION_ROLES.includes(role as InvitationRole)) {
        throw new BadRequestError("Role must be 'worker' or 'manager'.", "INVITATION_INVALID");
    }
    return role as InvitationRole;
};

const validateSiteIds = (sites: unknown): mongoose.Types.ObjectId[] | undefined => {
    if (sites === undefined) return undefined;
    if (!Array.isArray(sites) || !sites.length) return undefined;
    if (!sites.every((s: unknown) => typeof s === "string" && mongoose.Types.ObjectId.isValid(s))) {
        throw new BadRequestError("Invalid site id.", "INVITATION_INVALID");
    }
    // No Site model exists yet in this codebase, so "belongs to the same
    // company" can't actually be checked against a collection — see the
    // note left in invitationModel.ts.
    return sites.map((s: string) => new mongoose.Types.ObjectId(s));
};

const validatePayRate = (payRate: unknown): number | undefined => {
    if (payRate === undefined) return undefined;
    if (typeof payRate !== "number" || !Number.isFinite(payRate) || payRate < 0) {
        throw new BadRequestError("Pay rate must be a non-negative number.", "INVITATION_INVALID");
    }
    return payRate;
};

// ─────────────────────────────────────────────
// Create
// ─────────────────────────────────────────────
export const createInvitation: MiddlewareFn = async (req, res) => {
    const companyId = req.user.company_id;
    const inviterId = req.user.user_id;

    const email = normalizeEmail(req.body.email);
    const role = validateRole(req.body.role);

    // No granular per-company permission system exists yet — the only rule
    // enforced here is the one explicitly called for: a manager can invite
    // workers but not other managers.
    if (req.user.role === "manager" && role === "manager") {
        throw new UnauthorizedError("Managers cannot invite other managers.", "INSUFFICIENT_PERMISSION");
    }

    const fullname = typeof req.body.fullname === "string" ? req.body.fullname.trim() || undefined : undefined;
    const phone = typeof req.body.phone === "string" ? req.body.phone.trim() || undefined : undefined;
    const employeeId = typeof req.body.employeeId === "string" ? req.body.employeeId.trim() || undefined : undefined;
    const sites = validateSiteIds(req.body.sites);
    const payRate = validatePayRate(req.body.payRate);

    const existingMember = await User.findOne({ email, company: companyId });
    if (existingMember) {
        throw new ConflictError("This person already belongs to your company.", "ALREADY_MEMBER");
    }

    const existingInvite = await Invitation.findOne({ company: companyId, email, status: "pending" });
    if (existingInvite) {
        if (existingInvite.expiresAt < new Date()) {
            existingInvite.status = "expired";
            await existingInvite.save();
        } else {
            throw new ConflictError(
                `An invitation is already pending for this email.`,
                "INVITATION_PENDING"
            );
        }
    }

    const { token, hash, expiresAt } = createInvitationToken();

    let invitation;
    try {
        invitation = await Invitation.create({
            company: companyId,
            email,
            fullname,
            phone,
            role,
            invitedBy: inviterId,
            tokenHash: hash,
            status: "pending",
            expiresAt,
            sites,
            payRate,
            employeeId,
        });
    } catch (err: any) {
        // A concurrent request winning the race on the partial unique index
        // surfaces as a raw duplicate-key error — translate it rather than
        // letting it fall through as a 500.
        if (err?.code === 11000) {
            throw new ConflictError("An invitation is already pending for this email.", "INVITATION_PENDING");
        }
        throw err;
    }

    const [company, inviter] = await Promise.all([
        Company.findById(companyId).select("name").lean(),
        User.findById(inviterId).select("fullname").lean(),
    ]);

    // Fire-and-forget, same pattern as every other notification in this app.
    sendInvitationEmail({
        email,
        fullname: invitation.fullname,
        companyName: company?.name ?? "your company",
        inviterName: inviter?.fullname ?? "A team member",
        role,
        invitationToken: token,
    }).catch(err => console.error(`Failed to send invitation email to ${email}:`, err));

    res.status(StatusCodes.CREATED).json({
        success: true,
        msg: "Invitation sent.",
        invitation: {
            _id: invitation._id,
            email: invitation.email,
            fullname: invitation.fullname,
            role: invitation.role,
            status: invitation.status,
            expiresAt: invitation.expiresAt,
            createdAt: invitation.createdAt,
        },
    });
};

// ─────────────────────────────────────────────
// Public: validate
// ─────────────────────────────────────────────
export const validateInvitation: MiddlewareFn = async (req, res) => {
    const token = req.query.token;
    if (!token || typeof token !== "string") {
        res.status(StatusCodes.OK).json({ success: true, status: "invalid", invitation: null });
        return;
    }

    const hash = hashInvitationToken(token);
    const invitation = await Invitation.findOne({ tokenHash: hash })
        .populate("company", "name")
        .populate("invitedBy", "fullname");
    console.log("invitation : ", invitation)
    if (!invitation) {
        res.status(StatusCodes.OK).json({ success: true, status: "invalid", invitation: null });
        return;
    }

    if (invitation.status === "pending" && invitation.expiresAt < new Date()) {
        invitation.status = "expired";
        await invitation.save();
    }

    const base = {
        _id: invitation._id,
        company: invitation.company,
        email: invitation.email,
        fullname: invitation.fullname,
        role: invitation.role,
        status: invitation.status,
        invitedBy: invitation.invitedBy,
        expiresAt: invitation.expiresAt,
    };

    if (invitation.status !== "pending") {
        res.status(StatusCodes.OK).json({ success: true, status: invitation.status, invitation: base });
        return;
    }

    const accountExists = !!(await User.exists({ email: invitation.email }));

    res.status(StatusCodes.OK).json({
        success: true,
        status: "pending",
        invitation: { ...base, accountExists },
    });
};

// Shared terminal-state checks for both acceptance endpoints.
async function loadAcceptableInvitation(token: unknown) {
    if (!token || typeof token !== "string") {
        throw new BadRequestError("Invitation token is required.", "INVITATION_INVALID");
    }

    const hash = hashInvitationToken(token);
    const invitation = await Invitation.findOne({ tokenHash: hash });

    if (!invitation) {
        throw new NotFoundError("This invitation link is invalid.", "INVITATION_NOT_FOUND");
    }
    if (invitation.status === "revoked") {
        throw new BadRequestError("This invitation has been cancelled.", "INVITATION_REVOKED");
    }
    if (invitation.status === "accepted") {
        throw new BadRequestError("This invitation has already been used.", "INVITATION_ACCEPTED");
    }
    if (invitation.status === "expired" || invitation.expiresAt < new Date()) {
        if (invitation.status === "pending") {
            invitation.status = "expired";
            await invitation.save();
        }
        throw new BadRequestError("This invitation has expired.", "INVITATION_EXPIRED");
    }

    return invitation;
}

// ─────────────────────────────────────────────
// Public: accept — new user (creates the account)
// ─────────────────────────────────────────────
export const acceptInvitation: MiddlewareFn = async (req, res) => {
    const { token, password } = req.body;
    const fullname = typeof req.body.fullname === "string" ? req.body.fullname.trim() : "";

    if (!password || typeof password !== "string" || password.length < 8) {
        throw new BadRequestError("Password must be at least 8 characters long.", "INVITATION_INVALID");
    }

    // Re-checked here rather than trusting whatever the earlier /validate
    // call returned — two tabs, a double-click, or a revoke/resend in
    // between are all real races this must not be fooled by.
    const invitation = await loadAcceptableInvitation(token);

    const existingUser = await User.findOne({ email: invitation.email });
    if (existingUser) {
        throw new BadRequestError(
            "An account already exists for this email. Please sign in instead.",
            "ACCOUNT_EXISTS"
        );
    }

    const hashedPassword = await hashPassword(password);

    let user;
    try {
        user = await User.create({
            fullname: fullname || invitation.fullname || invitation.email.split("@")[0],
            email: invitation.email,
            password: hashedPassword,
            role: invitation.role,
            company: invitation.company,
            createdBy: invitation.invitedBy,
            phone: invitation.phone || undefined,
            // Receiving and using a link sent to this exact address is
            // itself proof of ownership — equivalent to email verification.
            isVerified: true,
        });
    } catch (err: any) {
        if (err?.code === 11000) {
            throw new BadRequestError(
                "An account already exists for this email. Please sign in instead.",
                "ACCOUNT_EXISTS"
            );
        }
        throw err;
    }

    try {
        await NotificationPreferenceModel.create({ company: invitation.company, user: user._id });
    } catch (err) {
        // Mirrors this app's existing stance elsewhere: a side-effect
        // failure here shouldn't roll back a successful signup.
        console.error(`Failed to create notification preferences for invited user ${user._id}:`, err);
    }

    invitation.status = "accepted";
    invitation.acceptedAt = new Date();
    invitation.acceptedBy = user._id as mongoose.Types.ObjectId;
    await invitation.save();

    await issueTokens(user, res);

    res.status(StatusCodes.CREATED).json({
        success: true,
        msg: "Account created and invitation accepted.",
        user: sanitizeUser(user),
    });
};

// ─────────────────────────────────────────────
// Authenticated: accept — existing account
// ─────────────────────────────────────────────
export const acceptExistingUserInvitation: MiddlewareFn = async (req, res) => {
    const invitation = await loadAcceptableInvitation(req.body.token);

    const user = await User.findById(req.user.user_id);
    if (!user) throw new UnauthenticatedError("Please log in again.");

    if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
        throw new UnauthorizedError(
            "This invitation belongs to a different account.",
            "INVITATION_EMAIL_MISMATCH"
        );
    }

    // This codebase's User model is single-company (`company: ObjectId`,
    // not a memberships array) — there is no architecture for a user
    // belonging to more than one company. Rather than silently moving the
    // account out of whichever company it's currently in, joining a
    // *different* company is rejected outright. See the write-up in the
    // final report for the reasoning and the alternative (a real
    // membership model) if multi-company is actually wanted.
    if (user.company && user.company.toString() !== invitation.company.toString()) {
        throw new BadRequestError(
            "Your account already belongs to another company on this platform.",
            "ALREADY_IN_ANOTHER_COMPANY"
        );
    }

    if (user.company && user.company.toString() === invitation.company.toString()) {
        invitation.status = "accepted";
        invitation.acceptedAt = new Date();
        invitation.acceptedBy = user._id as mongoose.Types.ObjectId;
        await invitation.save();

        res.status(StatusCodes.OK).json({
            success: true,
            msg: "You're already a member of this company.",
            user: sanitizeUser(user),
        });
        return;
    }

    user.company = invitation.company;
    user.role = invitation.role;
    if (invitation.phone && !user.phone) user.phone = invitation.phone;
    await user.save();

    const existingPrefs = await NotificationPreferenceModel.findOne({
        user: user._id,
        company: invitation.company,
    });
    if (!existingPrefs) {
        await NotificationPreferenceModel.create({ company: invitation.company, user: user._id });
    }

    invitation.status = "accepted";
    invitation.acceptedAt = new Date();
    invitation.acceptedBy = user._id as mongoose.Types.ObjectId;
    await invitation.save();

    res.status(StatusCodes.OK).json({
        success: true,
        msg: "Invitation accepted.",
        user: sanitizeUser(user),
    });
};

// ─────────────────────────────────────────────
// List / get / update / resend / revoke
// ─────────────────────────────────────────────
export const getInvitations: MiddlewareFn = async (req, res) => {
    const { status, role, search, page = "1", limit: limitQuery = "20" } = req.query as Record<string, string>;
    const limit = Number(limitQuery) || 20;
    const currentPage = Number(page) || 1;
    const skip = (currentPage - 1) * limit;

    const query: Record<string, unknown> = { company: req.user.company_id };
    if (status && status !== "all") query.status = status;
    if (role && role !== "all") query.role = role;
    if (search) {
        query.$or = [
            { email: { $regex: search, $options: "i" } },
            { fullname: { $regex: search, $options: "i" } },
        ];
    }

    const [invitations, totalInvitations] = await Promise.all([
        Invitation.find(query)
            .populate("invitedBy", "fullname")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        Invitation.countDocuments(query),
    ]);

    res.status(StatusCodes.OK).json({
        success: true,
        invitations,
        totalInvitations,
        totalPages: Math.ceil(totalInvitations / limit),
        currentPage,
    });
};

export const getInvitation: MiddlewareFn = async (req, res) => {
    const invitation = await Invitation.findOne({ _id: req.params.id, company: req.user.company_id })
        .populate("invitedBy", "fullname")
        .lean();
    if (!invitation) throw new NotFoundError("Invitation not found.", "INVITATION_NOT_FOUND");
    res.status(StatusCodes.OK).json({ success: true, invitation });
};

const UPDATE_INVITATION_ALLOWED_FIELDS = ["fullname", "phone", "role", "sites", "payRate", "employeeId"] as const;

export const updateInvitation: MiddlewareFn = async (req, res) => {
    const invitation = await Invitation.findOne({ _id: req.params.id, company: req.user.company_id });
    if (!invitation) throw new NotFoundError("Invitation not found.", "INVITATION_NOT_FOUND");
    if (invitation.status !== "pending") {
        throw new BadRequestError("Only pending invitations can be edited.", "INVITATION_NOT_PENDING");
    }

    if (req.body.role !== undefined && req.user.role === "manager" && req.body.role === "manager") {
        throw new UnauthorizedError("Managers cannot invite other managers.", "INSUFFICIENT_PERMISSION");
    }

    for (const key of UPDATE_INVITATION_ALLOWED_FIELDS) {
        if (req.body[key] === undefined) continue;

        if (key === "role") {
            invitation.role = validateRole(req.body.role);
        } else if (key === "payRate") {
            invitation.payRate = validatePayRate(req.body.payRate);
        } else if (key === "sites") {
            invitation.sites = validateSiteIds(req.body.sites);
        } else if (key === "fullname") {
            invitation.fullname = typeof req.body.fullname === "string" ? req.body.fullname.trim() : undefined;
        } else if (key === "phone") {
            invitation.phone = typeof req.body.phone === "string" ? req.body.phone.trim() : undefined;
        } else if (key === "employeeId") {
            invitation.employeeId = typeof req.body.employeeId === "string" ? req.body.employeeId.trim() : undefined;
        }
    }

    await invitation.save();
    res.status(StatusCodes.OK).json({ success: true, msg: "Invitation updated.", invitation });
};

export const resendInvitation: MiddlewareFn = async (req, res) => {
    const invitation = await Invitation.findOne({ _id: req.params.id, company: req.user.company_id });
    if (!invitation) throw new NotFoundError("Invitation not found.", "INVITATION_NOT_FOUND");
    if (invitation.status !== "pending" && invitation.status !== "expired") {
        throw new BadRequestError(
            `This invitation is ${invitation.status} and can't be resent.`,
            "INVITATION_NOT_PENDING"
        );
    }

    const { token, hash, expiresAt } = createInvitationToken();
    invitation.tokenHash = hash;
    invitation.expiresAt = expiresAt;
    invitation.status = "pending";
    await invitation.save();

    const [company, inviter] = await Promise.all([
        Company.findById(req.user.company_id).select("name").lean(),
        User.findById(req.user.user_id).select("fullname").lean(),
    ]);

    sendInvitationEmail({
        email: invitation.email,
        fullname: invitation.fullname,
        companyName: company?.name ?? "your company",
        inviterName: inviter?.fullname ?? "A team member",
        role: invitation.role,
        invitationToken: token,
    }).catch(err => console.error(`Failed to resend invitation email to ${invitation.email}:`, err));

    res.status(StatusCodes.OK).json({ success: true, msg: "Invitation resent." });
};

export const revokeInvitation: MiddlewareFn = async (req, res) => {
    const invitation = await Invitation.findOne({ _id: req.params.id, company: req.user.company_id });
    if (!invitation) throw new NotFoundError("Invitation not found.", "INVITATION_NOT_FOUND");
    if (invitation.status === "accepted") {
        throw new BadRequestError(
            "This invitation has already been accepted and can't be revoked.",
            "INVITATION_ACCEPTED"
        );
    }

    invitation.status = "revoked";
    await invitation.save();

    res.status(StatusCodes.OK).json({ success: true, msg: "Invitation revoked." });
};
