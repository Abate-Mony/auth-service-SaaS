import { StatusCodes } from "http-status-codes";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { getReqUser, MiddlewareFn } from "../interfaces/expresstype.js";
import Job from "../models/jobModel.js";
import JobChangeRequest from "../models/JobChangeRequest.js";
import User from "../models/userModel.js";
import { applyJobCancellationSideEffects } from "./jobController.js";
import { shouldNotify } from "../services/notificationPreferenceService.js";
import { sendJobChangeRequestDeclinedEmail } from "../utils/mailTemplates.js";

const STATUSES = ["pending", "approved", "declined", "cancelled"] as const;
const TYPES = ["reschedule", "cancel"] as const;

// GET /job-change-requests?status=&type=
export const getJobChangeRequests: MiddlewareFn = async (req, res) => {
    const { company_id } = getReqUser(req);
    const { status, type } = req.query;

    const filter: Record<string, unknown> = { company: company_id, isDeleted: false };
    if (typeof status === "string" && (STATUSES as readonly string[]).includes(status)) {
        filter.status = status;
    }
    if (typeof type === "string" && (TYPES as readonly string[]).includes(type)) {
        filter.type = type;
    }

    const requests = await JobChangeRequest.find(filter)
        .sort({ createdAt: -1 })
        .populate("client", "name")
        .populate("requestedBy", "fullname email")
        .populate("job", "title date startTime endTime status")
        .lean();

    res.status(StatusCodes.OK).json({ success: true, requests });
};

// GET /job-change-requests/:id — also used by work.wk's EditJobPage.tsx to
// prefill the form from a reschedule request being approved.
export const getJobChangeRequest: MiddlewareFn = async (req, res) => {
    const { company_id } = getReqUser(req);
    const request = await JobChangeRequest.findOne({ _id: req.params.id, company: company_id, isDeleted: false })
        .populate("client", "name")
        .populate("requestedBy", "fullname email")
        .populate("job", "title date startTime endTime status");
    if (!request) throw new NotFoundError("Change request not found.");

    res.status(StatusCodes.OK).json({ success: true, request });
};

// PATCH /job-change-requests/:id/decline — valid for either type.
export const declineJobChangeRequest: MiddlewareFn = async (req, res) => {
    const { user_id, company_id } = getReqUser(req);
    const { reviewNotes } = req.body;

    const request = await JobChangeRequest.findOne({ _id: req.params.id, company: company_id, isDeleted: false });
    if (!request) throw new NotFoundError("Change request not found.");
    if (request.status !== "pending") {
        throw new BadRequestError(`This request has already been ${request.status}.`);
    }

    request.status = "declined";
    request.reviewedBy = user_id as any;
    request.reviewedAt = new Date();
    if (typeof reviewNotes === "string") request.reviewNotes = reviewNotes.trim().slice(0, 500);
    await request.save();

    // Best-effort — the staff member's decline must succeed even if
    // notifying the client fails. Same reasoning as declineBookingRequest.
    (async () => {
        const requester = await User.findById(request.requestedBy).select("fullname email");
        if (!requester?.email) return;
        const canEmail = await shouldNotify(requester._id.toString(), "job_change_request_declined", "email");
        if (!canEmail) return;
        await sendJobChangeRequestDeclinedEmail({
            email: requester.email,
            fullname: requester.fullname,
            type: request.type as "reschedule" | "cancel",
            originalDate: request.originalDate,
            reviewNotes: request.reviewNotes || undefined,
            company: company_id,
        });
    })().catch(err => console.error(`Failed to notify client of declined job change request ${request._id}:`, err));

    res.status(StatusCodes.OK).json({ success: true, request });
};

// PATCH /job-change-requests/:id/approve-cancel — the one single-click
// approval. Reschedule approval happens inside updateJob instead (see
// maybeApproveJobChangeRequest in jobController.ts) — staff must go through
// the real Edit Job form for that, never a status-flip here.
export const approveCancelJobChangeRequest: MiddlewareFn = async (req, res) => {
    const { user_id, company_id } = getReqUser(req);

    const request = await JobChangeRequest.findOne({ _id: req.params.id, company: company_id, isDeleted: false });
    if (!request) throw new NotFoundError("Change request not found.");
    if (request.type !== "cancel") {
        throw new BadRequestError("Only a cancellation request can be approved here — reschedule requests are approved by editing the job.");
    }
    if (request.status !== "pending") {
        throw new BadRequestError(`This request has already been ${request.status}.`);
    }

    const job = await Job.findOne({ _id: request.job, company: company_id.toString(), isDeleted: false });

    // Race safety: the job may have been cancelled/completed by other means
    // since the request was submitted. Rather than erroring blind, resolve
    // the now-stale request as declined with an explanatory note.
    if (!job || job.status === "cancelled" || job.status === "completed") {
        request.status = "declined";
        request.reviewedBy = user_id as any;
        request.reviewedAt = new Date();
        request.reviewNotes = job ? `Job was already ${job.status} by other means.` : "Job no longer exists.";
        await request.save();
        res.status(StatusCodes.OK).json({ success: true, request, staleRequest: true });
        return;
    }

    job.status = "cancelled" as any;
    const updatedJob = await job.save();
    await applyJobCancellationSideEffects(updatedJob, { actorId: user_id, reason: request.reason || undefined });

    request.status = "approved";
    request.reviewedBy = user_id as any;
    request.reviewedAt = new Date();
    await request.save();

    res.status(StatusCodes.OK).json({ success: true, request });
};
