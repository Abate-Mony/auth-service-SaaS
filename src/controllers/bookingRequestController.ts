import { StatusCodes } from "http-status-codes";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { getReqUser, MiddlewareFn } from "../interfaces/expresstype.js";
import BookingRequest from "../models/BookingRequest.js";
import User from "../models/userModel.js";
import { shouldNotify } from "../services/notificationPreferenceService.js";
import { sendBookingRequestDeclinedEmail } from "../utils/mailTemplates.js";

const STATUSES = ["pending", "approved", "declined", "cancelled"] as const;

// GET /booking-requests?status=
export const getBookingRequests: MiddlewareFn = async (req, res) => {
    const { company_id } = getReqUser(req);
    const { status } = req.query;

    const filter: Record<string, unknown> = { company: company_id, isDeleted: false };
    if (typeof status === "string" && (STATUSES as readonly string[]).includes(status)) {
        filter.status = status;
    }

    const requests = await BookingRequest.find(filter)
        .sort({ createdAt: -1 })
        .populate("client", "name")
        .populate("requestedBy", "fullname email")
        .lean();

    res.status(StatusCodes.OK).json({ success: true, requests });
};

// GET /booking-requests/:id — also used by work.wk's CreateJob.tsx to
// prefill the form from a request being approved.
export const getBookingRequest: MiddlewareFn = async (req, res) => {
    const { company_id } = getReqUser(req);
    const request = await BookingRequest.findOne({ _id: req.params.id, company: company_id, isDeleted: false })
        .populate("client", "name")
        .populate("requestedBy", "fullname email");
    if (!request) throw new NotFoundError("Booking request not found.");

    res.status(StatusCodes.OK).json({ success: true, request });
};

// PATCH /booking-requests/:id/decline — the only review action with its
// own endpoint. There's no approveBookingRequest: approving only ever
// happens as a side effect of actually creating the Job (see
// jobController.ts's createJob, bookingRequestId handling) — deliberately,
// so staff can't approve a request without having reviewed/completed the
// real scheduling details a client's loose preference never includes.
export const declineBookingRequest: MiddlewareFn = async (req, res) => {
    const { user_id, company_id } = getReqUser(req);
    const { reviewNotes } = req.body;

    const request = await BookingRequest.findOne({ _id: req.params.id, company: company_id, isDeleted: false });
    if (!request) throw new NotFoundError("Booking request not found.");
    if (request.status !== "pending") {
        throw new BadRequestError(`This request has already been ${request.status}.`);
    }

    request.status = "declined";
    request.reviewedBy = user_id as any;
    request.reviewedAt = new Date();
    if (typeof reviewNotes === "string") request.reviewNotes = reviewNotes.trim().slice(0, 500);
    await request.save();

    // Best-effort — the staff member's decline must succeed even if
    // notifying the client fails. Email is the only channel that actually
    // reaches a portal user today (no in-app bell or push registration in
    // client_portal_onclockly yet) — see notifyStaffOfBookingRequest's own
    // comment in portalBookingRequestController.ts for the fuller reasoning.
    (async () => {
        const requester = await User.findById(request.requestedBy).select("fullname email");
        if (!requester?.email) return;
        const canEmail = await shouldNotify(requester._id.toString(), "booking_request_declined", "email");
        if (!canEmail) return;
        await sendBookingRequestDeclinedEmail({
            email: requester.email,
            fullname: requester.fullname,
            service: request.service,
            preferredDate: request.preferredDate,
            reviewNotes: request.reviewNotes || undefined,
            company: company_id,
        });
    })().catch(err => console.error(`Failed to notify client of declined booking request ${request._id}:`, err));

    res.status(StatusCodes.OK).json({ success: true, request });
};
