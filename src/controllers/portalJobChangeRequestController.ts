import { StatusCodes } from "http-status-codes";
import { BadRequestError, NotFoundError, UnauthorizedError } from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import Job from "../models/jobModel.js";
import JobChangeRequest from "../models/JobChangeRequest.js";
import User from "../models/userModel.js";
import { toUtcDay } from "../utils/dates.js";
import { shouldNotify } from "../services/notificationPreferenceService.js";
import { sendJobChangeRequestSubmittedEmail } from "../utils/mailTemplates.js";
import { sendPushToUser } from "../utils/webPush.js";
import { sendExpoPushToUser } from "../utils/expoPush.js";
import { notifyUser } from "../utils/notifyUser.js";
import { MANAGEMENT_ROLES } from "../utils/roles.js";
import { canClient, type ClientRole } from "../utils/clientPermissions.js";
import { toPortalJobChangeRequest } from "../utils/portalSerializers.js";

// Best-effort, fire-and-forget — same reasoning as notifyStaffOfBookingRequest
// in portalBookingRequestController.ts: a notification hiccup must never fail
// the client's own submission.
function notifyStaffOfJobChangeRequest(
    companyId: unknown,
    requesterName: string,
    jobTitle: string,
    type: "reschedule" | "cancel",
    link: string
) {
    const verb = type === "reschedule" ? "reschedule" : "cancel";
    User.find({ company: companyId, role: { $in: MANAGEMENT_ROLES }, isActive: true })
        .select("_id email")
        .then(staff =>
            Promise.all(
                staff.map(async u => {
                    const userId = u._id.toString();
                    const [canEmail, canPush] = await Promise.all([
                        shouldNotify(userId, "job_change_request_submitted", "email"),
                        shouldNotify(userId, "job_change_request_submitted", "push"),
                    ]);

                    await Promise.all([
                        notifyUser({
                            userId,
                            companyId,
                            event: "job_change_request_submitted",
                            title: "New change request",
                            body: `${requesterName} requested to ${verb} "${jobTitle}"`,
                            link,
                        }),
                        canEmail
                            ? sendJobChangeRequestSubmittedEmail({
                                staffEmail: u.email,
                                requesterName,
                                jobTitle,
                                type,
                                link,
                                company: companyId,
                            })
                            : Promise.resolve(),
                        canPush
                            ? sendPushToUser(userId, {
                                title: "New change request",
                                body: `${requesterName} requested to ${verb} "${jobTitle}"`,
                                tag: "job-change-request-submitted",
                                url: link,
                            })
                            : Promise.resolve(),
                        canPush
                            ? sendExpoPushToUser(userId, {
                                title: "New change request",
                                body: `${requesterName} requested to ${verb} "${jobTitle}"`,
                                tag: "job-change-request-submitted",
                                url: link,
                            })
                            : Promise.resolve(),
                    ]);
                })
            )
        )
        .catch(err => console.error(`Failed to notify staff of job change request:`, err));
}

async function loadEligibleJob(jobId: string, req: any) {
    const job = await Job.findOne({
        _id: jobId,
        client: req.user.client_id,
        company: req.user.company_id.toString(),
        isDeleted: false,
    });
    if (!job) throw new NotFoundError("Booking not found.");
    if (!["draft", "published"].includes(job.status)) {
        throw new BadRequestError(`This booking is already ${job.status} and can no longer be changed.`);
    }
    if (toUtcDay(job.date) < toUtcDay(new Date())) {
        throw new BadRequestError("This booking has already happened.");
    }

    const existing = await JobChangeRequest.findOne({ job: job._id, status: "pending", isDeleted: false });
    if (existing) {
        throw new BadRequestError("There's already a pending change request for this booking.");
    }

    return job;
}

// POST /portal/bookings/:id/reschedule-request
export const createRescheduleRequest: MiddlewareFn = async (req, res) => {
    const { requestedDate, requestedStartTime, requestedEndTime, reason } = req.body;

    if (typeof requestedStartTime !== "string" || !requestedStartTime.trim()) {
        throw new BadRequestError("A requested start time is required.");
    }
    if (typeof requestedEndTime !== "string" || !requestedEndTime.trim()) {
        throw new BadRequestError("A requested end time is required.");
    }
    const parsedDate = new Date(requestedDate);
    if (Number.isNaN(parsedDate.getTime())) {
        throw new BadRequestError("A valid requested date is required.");
    }

    const job = await loadEligibleJob(req.params.id, req);

    const request = await JobChangeRequest.create({
        company: req.user.company_id,
        client: req.user.client_id,
        job: job._id,
        requestedBy: req.user.user_id,
        type: "reschedule",
        requestedDate: toUtcDay(parsedDate),
        requestedStartTime: requestedStartTime.trim().slice(0, 10),
        requestedEndTime: requestedEndTime.trim().slice(0, 10),
        reason: typeof reason === "string" ? reason.trim().slice(0, 1000) : "",
        originalDate: job.date,
        originalStartTime: job.startTime,
        originalEndTime: job.endTime,
    });

    const user = await User.findById(req.user.user_id).select("fullname");
    notifyStaffOfJobChangeRequest(req.user.company_id, user?.fullname ?? "A client", job.title, "reschedule", "/job-change-requests");

    res.status(StatusCodes.CREATED).json({ success: true, request: toPortalJobChangeRequest(request.toObject()) });
};

// POST /portal/bookings/:id/cancel-request
export const createCancelRequest: MiddlewareFn = async (req, res) => {
    const { reason } = req.body;

    const job = await loadEligibleJob(req.params.id, req);

    const request = await JobChangeRequest.create({
        company: req.user.company_id,
        client: req.user.client_id,
        job: job._id,
        requestedBy: req.user.user_id,
        type: "cancel",
        reason: typeof reason === "string" ? reason.trim().slice(0, 1000) : "",
        originalDate: job.date,
        originalStartTime: job.startTime,
        originalEndTime: job.endTime,
    });

    const user = await User.findById(req.user.user_id).select("fullname");
    notifyStaffOfJobChangeRequest(req.user.company_id, user?.fullname ?? "A client", job.title, "cancel", "/job-change-requests");

    res.status(StatusCodes.CREATED).json({ success: true, request: toPortalJobChangeRequest(request.toObject()) });
};

// GET /portal/bookings/:id/change-requests
export const getBookingChangeRequests: MiddlewareFn = async (req, res) => {
    const requests = await JobChangeRequest.find({
        job: req.params.id,
        client: req.user.client_id,
        company: req.user.company_id,
        isDeleted: false,
    }).sort({ createdAt: -1 }).lean();

    res.status(StatusCodes.OK).json({ success: true, requests: requests.map(toPortalJobChangeRequest) });
};

// PATCH /portal/change-requests/:id/cancel — withdraw own pending request.
// Gated inline rather than via requireClientPermission at the route level,
// since which action applies depends on the request's own `type`.
export const withdrawJobChangeRequest: MiddlewareFn = async (req, res) => {
    const request = await JobChangeRequest.findOne({
        _id: req.params.id,
        client: req.user.client_id,
        company: req.user.company_id,
        isDeleted: false,
    });
    if (!request) throw new NotFoundError("Change request not found.");
    if (request.status !== "pending") {
        throw new BadRequestError(`Only a pending request can be withdrawn (this one is ${request.status}).`);
    }

    const user = await User.findOne({ _id: req.user.user_id, role: "client", isActive: true }).select("clientRole");
    const action = request.type === "reschedule" ? "booking:update" : "booking:cancel";
    if (!user?.clientRole || !canClient(user.clientRole as ClientRole, action)) {
        throw new UnauthorizedError("You don't have permission to withdraw this request.");
    }

    request.status = "cancelled";
    await request.save();

    res.status(StatusCodes.OK).json({ success: true, request: toPortalJobChangeRequest(request.toObject()) });
};
