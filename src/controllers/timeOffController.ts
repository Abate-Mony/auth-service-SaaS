import { StatusCodes } from "http-status-codes";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { getReqUser, MiddlewareFn } from "../interfaces/expresstype.js";
import TimeOffRequest from "../models/TimeOffRequest.js";
import userModel from "../models/userModel.js";
import { sendTimeOffRequested, sendTimeOffReviewed } from "../utils/mailTemplates.js";
import { sendPushToUser } from "../utils/webPush.js";
import { sendExpoPushToUser } from "../utils/expoPush.js";
import { notifyUser } from "../utils/notifyUser.js";
import { MANAGEMENT_ROLES } from "../utils/roles.js";

const ALLOWED_TYPES = ["vacation", "sick", "personal", "other"] as const;
type TimeOffType = (typeof ALLOWED_TYPES)[number];

function parseDateRange(startDateRaw: unknown, endDateRaw: unknown): { startDate: Date; endDate: Date } {
    const startDate = new Date(startDateRaw as string);
    const endDate = new Date(endDateRaw as string);

    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        throw new BadRequestError("startDate and endDate must be valid dates.");
    }
    if (startDate > endDate) {
        throw new BadRequestError("startDate must be on or before endDate.");
    }
    return { startDate, endDate };
}

// Fire-and-forget: a worker's request should complete even if notifying
// managers fails. Broadcasts to every admin/manager/owner at the company,
// same reasoning as the equivalent helper in workerController.ts — whoever
// is free to review it shouldn't depend on who happens to be watching.
async function notifyManagersOfRequest(params: {
    companyId: string;
    workerFullname: string;
    startDate: Date;
    endDate: Date;
    type: string;
    reason: string;
}): Promise<void> {
    const managers = await userModel
        .find({ company: params.companyId, role: { $in: MANAGEMENT_ROLES }, isActive: true })
        .select("email");
    if (!managers.length) return;

    await Promise.all(
        managers.map(async (manager) => {
            await Promise.all([
                notifyUser({
                    userId: manager._id.toString(),
                    companyId: params.companyId,
                    event: "time_off_requested",
                    title: "Time-off request",
                    body: `${params.workerFullname} requested time off`,
                    link: "/time-off",
                }),
                sendPushToUser(manager._id.toString(), {
                    title: "Time-off request",
                    body: `${params.workerFullname} requested time off`,
                    tag: "time-off-requested",
                    url: "/time-off",
                }),
                sendExpoPushToUser(manager._id.toString(), {
                    title: "Time-off request",
                    body: `${params.workerFullname} requested time off`,
                    tag: "time-off-requested",
                    url: "/time-off",
                }),
                sendTimeOffRequested({
                    managerEmail: manager.email,
                    workerFullname: params.workerFullname,
                    startDate: params.startDate,
                    endDate: params.endDate,
                    type: params.type,
                    reason: params.reason || undefined,
                    company: params.companyId,
                }),
            ]);
        })
    ).catch(err => console.error("Failed to notify managers of time-off request:", err));
}

// ── Worker-facing ────────────────────────────────────────────────────────

export const requestTimeOff: MiddlewareFn = async (req, res) => {
    const { user_id, company_id } = getReqUser(req);
    const { startDate: startDateRaw, endDate: endDateRaw, type, reason } = req.body;

    const { startDate, endDate } = parseDateRange(startDateRaw, endDateRaw);

    const requestType: TimeOffType =
        typeof type === "string" && (ALLOWED_TYPES as readonly string[]).includes(type)
            ? (type as TimeOffType)
            : "other";
    const requestReason = typeof reason === "string" ? reason.trim().slice(0, 500) : "";

    // Avoid duplicate pending requests silently stacking up for the same
    // overlapping range — a worker resubmitting the same dates almost
    // always means they're unsure the first one went through.
    const overlappingPending = await TimeOffRequest.exists({
        worker: user_id,
        status: "pending",
        isDeleted: false,
        startDate: { $lte: endDate },
        endDate: { $gte: startDate },
    });
    if (overlappingPending) {
        throw new BadRequestError("You already have a pending request that overlaps these dates.");
    }

    const worker = await userModel.findById(user_id).select("fullname");
    if (!worker) throw new NotFoundError("Worker not found.");

    const request = await TimeOffRequest.create({
        worker: user_id,
        company: company_id,
        startDate,
        endDate,
        type: requestType,
        reason: requestReason,
        status: "pending",
    });

    notifyManagersOfRequest({
        companyId: company_id.toString(),
        workerFullname: worker.fullname,
        startDate,
        endDate,
        type: requestType,
        reason: requestReason,
    }).catch(err => console.error("Failed to notify managers of time-off request:", err));

    res.status(StatusCodes.CREATED).json({ success: true, request });
};

export const getMyTimeOffRequests: MiddlewareFn = async (req, res) => {
    const { user_id } = getReqUser(req);
    const { status } = req.query;

    const filter: Record<string, unknown> = { worker: user_id, isDeleted: false };
    if (typeof status === "string" && ["pending", "approved", "rejected", "cancelled"].includes(status)) {
        filter.status = status;
    }

    const requests = await TimeOffRequest.find(filter).sort({ createdAt: -1 }).lean();
    res.status(StatusCodes.OK).json({ success: true, requests });
};

export const cancelTimeOffRequest: MiddlewareFn = async (req, res) => {
    const { user_id } = getReqUser(req);
    const { id } = req.params;

    const request = await TimeOffRequest.findOne({ _id: id, worker: user_id, isDeleted: false });
    if (!request) throw new NotFoundError("Request not found.");
    if (request.status !== "pending") {
        throw new BadRequestError(`Only a pending request can be cancelled (this one is ${request.status}).`);
    }

    request.status = "cancelled";
    await request.save();

    res.status(StatusCodes.OK).json({ success: true, request });
};

// ── Manager-facing ───────────────────────────────────────────────────────

export const getCompanyTimeOffRequests: MiddlewareFn = async (req, res) => {
    const { company_id } = getReqUser(req);
    const { status } = req.query;

    const filter: Record<string, unknown> = { company: company_id, isDeleted: false };
    if (typeof status === "string" && ["pending", "approved", "rejected", "cancelled"].includes(status)) {
        filter.status = status;
    }

    const requests = await TimeOffRequest.find(filter)
        .sort({ createdAt: -1 })
        .populate("worker", "fullname email")
        .lean();

    res.status(StatusCodes.OK).json({ success: true, requests });
};

export const reviewTimeOffRequest: MiddlewareFn = async (req, res) => {
    const { user_id, company_id } = getReqUser(req);
    const { id } = req.params;
    const { decision, managerNotes } = req.body;

    if (!["approve", "reject"].includes(decision)) {
        throw new BadRequestError("decision must be 'approve' or 'reject'.");
    }

    const request = await TimeOffRequest.findOne({ _id: id, company: company_id, isDeleted: false });
    if (!request) throw new NotFoundError("Request not found.");
    if (request.status !== "pending") {
        throw new BadRequestError(`This request has already been ${request.status}.`);
    }

    const worker = await userModel.findById(request.worker).select("fullname email");
    if (!worker) throw new NotFoundError("Worker not found.");

    const approved = decision === "approve";

    request.status = approved ? "approved" : "rejected";
    request.reviewedBy = user_id as any;
    request.reviewedAt = new Date();
    if (typeof managerNotes === "string") request.managerNotes = managerNotes.trim().slice(0, 500);
    await request.save();

    Promise.all([
        notifyUser({
            userId: worker._id.toString(),
            companyId: company_id.toString(),
            event: "time_off_reviewed",
            title: approved ? "Time off approved" : "Time off declined",
            body: approved ? "Your time-off request was approved" : "Your time-off request was declined",
            link: "/worker/profile",
        }),
        sendPushToUser(worker._id.toString(), {
            title: approved ? "Time off approved" : "Time off declined",
            body: approved ? "Your time-off request was approved" : "Your time-off request was declined",
            tag: "time-off-reviewed",
            url: "/worker/profile",
        }),
        sendExpoPushToUser(worker._id.toString(), {
            title: approved ? "Time off approved" : "Time off declined",
            body: approved ? "Your time-off request was approved" : "Your time-off request was declined",
            tag: "time-off-reviewed",
            url: "/worker/profile",
        }),
        sendTimeOffReviewed({
            email: worker.email,
            fullname: worker.fullname,
            startDate: request.startDate,
            endDate: request.endDate,
            approved,
            managerNotes: request.managerNotes || undefined,
            company: company_id.toString(),
        }),
    ]).catch(err => console.error(`Failed to notify worker of time-off review for request ${request._id}:`, err));

    res.status(StatusCodes.OK).json({ success: true, request });
};
