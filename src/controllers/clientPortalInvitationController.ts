import { StatusCodes } from "http-status-codes";
import mongoose from "mongoose";
import {
    BadRequestError,
    ConflictError,
    NotFoundError,
} from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import Client from "../models/clientModel.js";
import ClientPortalInvitation, { type ClientRole } from "../models/clientPortalInvitationModel.js";
import User from "../models/userModel.js";
import Company from "../models/company.js";
import { hashPassword } from "../utils/passwordUtils.js";
import { createInvitationToken, hashInvitationToken, sanitizeUser } from "../utils/tokenUtils.js";
import { sendClientPortalInvitationEmail } from "../utils/mailTemplates.js";
import { issueTokens } from "./authControler.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CLIENT_ROLES: ClientRole[] = ["owner", "manager", "booking", "billing", "viewer"];

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

const validateClientRole = (role: unknown): ClientRole => {
    if (!CLIENT_ROLES.includes(role as ClientRole)) {
        throw new BadRequestError("Role must be one of owner, manager, booking, billing, viewer.", "INVITATION_INVALID");
    }
    return role as ClientRole;
};

// Tenant-isolation anchor for every staff-facing handler below. A `client`
// id alone is never sufficient scoping in a multi-tenant system — this
// also enforces "only lifecycle:'client' clients are inviteable" for free,
// since a lead/lost/deleted client simply won't resolve here.
async function loadClientScoped(clientId: string, companyId: unknown) {
    const client = await Client.findOne({
        _id: clientId,
        company: companyId,
        lifecycle: "client",
        isDeleted: false,
    });
    if (!client) throw new NotFoundError("Client not found.");
    return client;
}

// ─────────────────────────────────────────────
// Create
// ─────────────────────────────────────────────
export const createClientPortalInvitation: MiddlewareFn = async (req, res) => {
    const companyId = req.user.company_id;
    const inviterId = req.user.user_id;

    const client = await loadClientScoped(req.params.id as string, companyId);

    const email = normalizeEmail(req.body.email);
    const clientRole = validateClientRole(req.body.clientRole);
    const fullname = typeof req.body.fullname === "string" ? req.body.fullname.trim() || undefined : undefined;

    // User.email is globally unique (not scoped to company) — this check
    // must run before anything client-scoped, otherwise the invite could
    // be sent, accepted-up-to-the-password-screen, and only then fail on
    // User.create()'s unique-index violation. Deliberately not narrowed to
    // {email, client, role:"client"} — any existing account with this
    // email (staff, worker, or a portal user of a different client)
    // blocks the invite.
    const existingUser = await User.findOne({ email });
    if (existingUser) {
        throw new ConflictError("An account already exists with this email address.", "ACCOUNT_EXISTS");
    }

    const existingInvite = await ClientPortalInvitation.findOne({
        company: companyId,
        client: client._id,
        email,
        status: "pending",
    });
    if (existingInvite) {
        if (existingInvite.expiresAt < new Date()) {
            existingInvite.status = "expired";
            await existingInvite.save();
        } else {
            throw new ConflictError(
                "An invitation is already pending for this email.",
                "INVITATION_PENDING"
            );
        }
    }

    const { token, hash, expiresAt } = createInvitationToken();

    let invitation;
    try {
        invitation = await ClientPortalInvitation.create({
            company: companyId,
            client: client._id,
            email,
            fullname,
            clientRole,
            invitedBy: inviterId,
            tokenHash: hash,
            status: "pending",
            expiresAt,
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
        Company.findById(companyId).select("name emailSettings").lean(),
        User.findById(inviterId).select("fullname").lean(),
    ]);

    // Fire-and-forget, same pattern as every other notification in this app.
    sendClientPortalInvitationEmail({
        email,
        fullname: invitation.fullname,
        companyName: company?.name ?? "your company",
        clientName: client.name,
        inviterName: inviter?.fullname ?? "A team member",
        clientRole,
        invitationToken: token,
        company: company ?? companyId,
    }).catch(err => console.error(`Failed to send client portal invitation email to ${email}:`, err));

    res.status(StatusCodes.CREATED).json({
        success: true,
        msg: "Invitation sent.",
        invitation: {
            _id: invitation._id,
            email: invitation.email,
            fullname: invitation.fullname,
            clientRole: invitation.clientRole,
            status: invitation.status,
            expiresAt: invitation.expiresAt,
            createdAt: invitation.createdAt,
        },
    });
};

// ─────────────────────────────────────────────
// List portal users + invitations for a client
// ─────────────────────────────────────────────
export const getClientPortalUsers: MiddlewareFn = async (req, res) => {
    const companyId = req.user.company_id;
    const client = await loadClientScoped(req.params.id as string, companyId);

    const [users, invitations] = await Promise.all([
        User.find({ company: companyId, client: client._id, role: "client" })
            .select("fullname email clientRole isActive lastLogin createdAt")
            .sort({ createdAt: -1 })
            .lean(),
        ClientPortalInvitation.find({ company: companyId, client: client._id })
            .populate("invitedBy", "fullname")
            .sort({ createdAt: -1 })
            .lean(),
    ]);

    res.status(StatusCodes.OK).json({ success: true, users, invitations });
};

// ─────────────────────────────────────────────
// Update a portal user — edit role / disable / enable
// ─────────────────────────────────────────────
export const updateClientPortalUser: MiddlewareFn = async (req, res) => {
    const companyId = req.user.company_id;
    const client = await loadClientScoped(req.params.id as string, companyId);

    const user = await User.findOne({
        _id: req.params.userId,
        company: companyId,
        client: client._id,
        role: "client",
    });
    if (!user) throw new NotFoundError("Portal user not found.");

    if (req.body.clientRole !== undefined) {
        user.clientRole = validateClientRole(req.body.clientRole);
    }
    if (req.body.isActive !== undefined) {
        if (typeof req.body.isActive !== "boolean") {
            throw new BadRequestError("isActive must be a boolean.", "INVITATION_INVALID");
        }
        user.isActive = req.body.isActive;
    }

    await user.save();
    res.status(StatusCodes.OK).json({ success: true, msg: "Portal user updated.", user: sanitizeUser(user) });
};

// ─────────────────────────────────────────────
// Resend / revoke
// ─────────────────────────────────────────────
export const resendClientPortalInvitation: MiddlewareFn = async (req, res) => {
    const companyId = req.user.company_id;
    const client = await loadClientScoped(req.params.id as string, companyId);

    const invitation = await ClientPortalInvitation.findOne({
        _id: req.params.inviteId,
        company: companyId,
        client: client._id,
    });
    if (!invitation) throw new NotFoundError("Invitation not found.");
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
        Company.findById(companyId).select("name emailSettings").lean(),
        User.findById(req.user.user_id).select("fullname").lean(),
    ]);

    sendClientPortalInvitationEmail({
        email: invitation.email,
        fullname: invitation.fullname,
        companyName: company?.name ?? "your company",
        clientName: client.name,
        inviterName: inviter?.fullname ?? "A team member",
        clientRole: invitation.clientRole,
        invitationToken: token,
        company: company ?? companyId,
    }).catch(err => console.error(`Failed to resend client portal invitation email to ${invitation.email}:`, err));

    res.status(StatusCodes.OK).json({ success: true, msg: "Invitation resent." });
};

export const revokeClientPortalInvitation: MiddlewareFn = async (req, res) => {
    const companyId = req.user.company_id;
    const client = await loadClientScoped(req.params.id as string, companyId);

    const invitation = await ClientPortalInvitation.findOne({
        _id: req.params.inviteId,
        company: companyId,
        client: client._id,
    });
    if (!invitation) throw new NotFoundError("Invitation not found.");
    if (invitation.status === "accepted") {
        throw new BadRequestError(
            "This invitation has already been accepted and can't be revoked.",
            "INVITATION_ACCEPTED"
        );
    }

    invitation.status = "revoked";
    invitation.revokedAt = new Date();
    invitation.revokedBy = new mongoose.Types.ObjectId(req.user.user_id.toString());
    await invitation.save();

    res.status(StatusCodes.OK).json({ success: true, msg: "Invitation revoked." });
};

// ─────────────────────────────────────────────
// Public: validate
// ─────────────────────────────────────────────
export const validateClientPortalInvitation: MiddlewareFn = async (req, res) => {
    const token = req.params.token;
    if (!token || typeof token !== "string") {
        res.status(StatusCodes.OK).json({ success: true, status: "invalid", invitation: null });
        return;
    }

    const hash = hashInvitationToken(token);
    const invitation = await ClientPortalInvitation.findOne({ tokenHash: hash })
        .populate("company", "name")
        .populate("client", "name");
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
        client: invitation.client,
        email: invitation.email,
        fullname: invitation.fullname,
        clientRole: invitation.clientRole,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
    };

    if (invitation.status !== "pending") {
        res.status(StatusCodes.OK).json({ success: true, status: invitation.status, invitation: base });
        return;
    }

    // Global check — User.email has no company/client scoping to check
    // against, same reasoning as the create-time check above.
    const accountExists = !!(await User.exists({ email: invitation.email }));

    res.status(StatusCodes.OK).json({
        success: true,
        status: "pending",
        invitation: { ...base, accountExists },
    });
};

// Shared terminal-state checks for acceptance.
async function loadAcceptableInvitation(token: unknown) {
    if (!token || typeof token !== "string") {
        throw new BadRequestError("Invitation token is required.", "INVITATION_INVALID");
    }

    const hash = hashInvitationToken(token);
    const invitation = await ClientPortalInvitation.findOne({ tokenHash: hash });

    if (!invitation) {
        throw new NotFoundError("This invitation link is invalid.");
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
// Public: accept — creates the portal account
// ─────────────────────────────────────────────
export const acceptClientPortalInvitation: MiddlewareFn = async (req, res) => {
    const { password } = req.body;
    const token = req.params.token;
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
            role: "client",
            client: invitation.client,
            clientRole: invitation.clientRole,
            company: invitation.company,
            createdBy: invitation.invitedBy,
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

    // Deliberately no NotificationPreferenceModel.create() here — that
    // model is push/email-notification plumbing built for staff/workers,
    // not in scope for a client-portal account in this milestone.

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
