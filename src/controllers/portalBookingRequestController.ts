import { StatusCodes } from "http-status-codes";
import mongoose from "mongoose";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import BookingRequest from "../models/BookingRequest.js";
import Client from "../models/clientModel.js";
import User from "../models/userModel.js";
import { shouldNotify } from "../services/notificationPreferenceService.js";
import { sendBookingRequestSubmittedEmail } from "../utils/mailTemplates.js";
import { sendPushToUser } from "../utils/webPush.js";
import { sendExpoPushToUser } from "../utils/expoPush.js";
import { notifyUser } from "../utils/notifyUser.js";
import { MANAGEMENT_ROLES } from "../utils/roles.js";
import { toPortalBookingRequest } from "../utils/portalSerializers.js";

const STATUSES = ["pending", "approved", "declined", "cancelled"] as const;
const MAX_DATES_PER_REQUEST = 10;

type RequestedSlot = { date: Date; time?: string };

// Accepts either the original single-date body ({ preferredDate, preferredTime })
// or { dates: [{ preferredDate, preferredTime }, ...] } for several dates at once.
function parseRequestedSlots(body: any): RequestedSlot[] {
    const raw: any[] =
        Array.isArray(body?.dates) && body.dates.length > 0
            ? body.dates
            : [{ preferredDate: body?.preferredDate, preferredTime: body?.preferredTime }];

    if (raw.length > MAX_DATES_PER_REQUEST) {
        throw new BadRequestError(`You can request up to ${MAX_DATES_PER_REQUEST} dates at once.`);
    }

    const seen = new Set<string>();
    const slots = raw.map(slot => {
        const date = new Date(slot?.preferredDate);
        if (Number.isNaN(date.getTime())) {
            throw new BadRequestError("A valid preferred date is required.");
        }
        const time =
            typeof slot?.preferredTime === "string" && slot.preferredTime.trim()
                ? slot.preferredTime.trim().slice(0, 10)
                : undefined;
        const key = `${date.toISOString().slice(0, 10)}|${time ?? ""}`;
        if (seen.has(key)) throw new BadRequestError("Each date and time can only be requested once.");
        seen.add(key);
        return { date, time };
    });

    return slots.sort((a, b) => a.date.getTime() - b.date.getTime());
}

// Best-effort, fire-and-forget — same reasoning throughout this app: a
// notification hiccup must never fail the client's own submission. Gated
// per staff recipient via shouldNotify (the newer convention this session
// settled on — NOT the unconditional-push pattern timeOffController.ts's
// notifyManagersOfRequest uses). Push is attempted for consistency with
// that same gated pattern even though no staff member necessarily has a
// subscription — harmless no-op either way, same as it already is
// elsewhere when a recipient has none registered.
function notifyStaffOfBookingRequest(
    companyId: unknown,
    requesterName: string,
    service: string,
    link: string
) {
    User.find({ company: companyId, role: { $in: MANAGEMENT_ROLES }, isActive: true })
        .select("_id email")
        .then(staff =>
            Promise.all(
                staff.map(async u => {
                    const userId = u._id.toString();
                    const [canEmail, canPush] = await Promise.all([
                        shouldNotify(userId, "booking_request_submitted", "email"),
                        shouldNotify(userId, "booking_request_submitted", "push"),
                    ]);

                    await Promise.all([
                        notifyUser({
                            userId,
                            companyId,
                            event: "booking_request_submitted",
                            title: "New booking request",
                            body: `${requesterName} requested a booking for ${service}`,
                            link,
                        }),
                        canEmail
                            ? sendBookingRequestSubmittedEmail({
                                staffEmail: u.email,
                                requesterName,
                                service,
                                link,
                                company: companyId,
                            })
                            : Promise.resolve(),
                        canPush
                            ? sendPushToUser(userId, {
                                title: "New booking request",
                                body: `${requesterName} requested a booking for ${service}`,
                                tag: "booking-request-submitted",
                                url: link,
                            })
                            : Promise.resolve(),
                        canPush
                            ? sendExpoPushToUser(userId, {
                                title: "New booking request",
                                body: `${requesterName} requested a booking for ${service}`,
                                tag: "booking-request-submitted",
                                url: link,
                            })
                            : Promise.resolve(),
                    ]);
                })
            )
        )
        .catch(err => console.error(`Failed to notify staff of booking request:`, err));
}

// POST /portal/bookings/requests
export const createBookingRequest: MiddlewareFn = async (req, res) => {
    const { service, notes } = req.body;

    if (typeof service !== "string" || !service.trim()) {
        throw new BadRequestError("Service is required.");
    }
    const slots = parseRequestedSlots(req.body);

    const client = await Client.findOne({ _id: req.user.client_id, company: req.user.company_id, isDeleted: false }).select("name");
    if (!client) throw new NotFoundError("Client not found.");

    const batch = slots.length > 1 ? new mongoose.Types.ObjectId() : null;
    const trimmedService = service.trim().slice(0, 200);
    const trimmedNotes = typeof notes === "string" ? notes.trim().slice(0, 1000) : "";

    const requests = await BookingRequest.create(
        slots.map(slot => ({
            company: req.user.company_id,
            client: client._id,
            requestedBy: req.user.user_id,
            service: trimmedService,
            preferredDate: slot.date,
            preferredTime: slot.time,
            notes: trimmedNotes,
            status: "pending" as const,
            batch,
        }))
    );

    // One notification per submission, not one per date.
    const user = await User.findById(req.user.user_id).select("fullname");
    const serviceLabel = requests.length > 1 ? `${trimmedService} (${requests.length} dates)` : trimmedService;
    notifyStaffOfBookingRequest(req.user.company_id, user?.fullname ?? client.name, serviceLabel, "/booking-requests");

    const serialized = requests.map(r => toPortalBookingRequest(r.toObject()));
    // `request` kept for older app versions that only read a single request.
    res.status(StatusCodes.CREATED).json({ success: true, request: serialized[0], requests: serialized });
};

// GET /portal/bookings/requests?status=
export const getMyBookingRequests: MiddlewareFn = async (req, res) => {
    const { status } = req.query;
    const filter: Record<string, unknown> = { client: req.user.client_id, company: req.user.company_id, isDeleted: false };
    if (typeof status === "string" && (STATUSES as readonly string[]).includes(status)) {
        filter.status = status;
    }

    const requests = await BookingRequest.find(filter).sort({ createdAt: -1 }).lean();
    res.status(StatusCodes.OK).json({ success: true, requests: requests.map(toPortalBookingRequest) });
};

// GET /portal/bookings/requests/:id
export const getMyBookingRequest: MiddlewareFn = async (req, res) => {
    const request = await BookingRequest.findOne({
        _id: req.params.id,
        client: req.user.client_id,
        company: req.user.company_id,
        isDeleted: false,
    }).lean();
    if (!request) throw new NotFoundError("Booking request not found.");

    res.status(StatusCodes.OK).json({ success: true, request: toPortalBookingRequest(request) });
};

// PATCH /portal/bookings/requests/:id/cancel
export const cancelBookingRequest: MiddlewareFn = async (req, res) => {
    const request = await BookingRequest.findOne({
        _id: req.params.id,
        client: req.user.client_id,
        company: req.user.company_id,
        isDeleted: false,
    });
    if (!request) throw new NotFoundError("Booking request not found.");
    if (request.status !== "pending") {
        throw new BadRequestError(`Only a pending request can be cancelled (this one is ${request.status}).`);
    }

    request.status = "cancelled";
    await request.save();

    res.status(StatusCodes.OK).json({ success: true, request: toPortalBookingRequest(request.toObject()) });
};
