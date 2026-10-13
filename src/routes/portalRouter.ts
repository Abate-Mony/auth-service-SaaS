import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
    validateClientPortalInvitation,
    acceptClientPortalInvitation,
} from "../controllers/clientPortalInvitationController.js";
import {
    getPortalMe,
    getPortalBookings, getPortalBooking,
    getPortalQuotes, getPortalQuote, acceptPortalQuote, declinePortalQuote,
    getPortalInvoices, getPortalInvoice, downloadPortalInvoicePdf,
    getPortalSites, getPortalSite,
} from "../controllers/portalController.js";
import {
    createBookingRequest,
    getMyBookingRequests,
    cancelBookingRequest,
} from "../controllers/portalBookingRequestController.js";
import {
    createRescheduleRequest,
    createCancelRequest,
    getBookingChangeRequests,
    withdrawJobChangeRequest,
} from "../controllers/portalJobChangeRequestController.js";
import { authenticateUser, requireClientAccount, requireClientPermission } from "../middleware/authMiddleware.js";

const router = Router();

// Public routes only — the invitee isn't logged in yet, so this can't sit
// behind authenticateUser. Same shape as invitationRouter.ts's own limiter.
const publicInvitationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
});

router.get("/invitations/:token", publicInvitationLimiter, validateClientPortalInvitation);
router.post("/invitations/:token/accept", publicInvitationLimiter, acceptClientPortalInvitation);

router.get("/me", authenticateUser, requireClientAccount, getPortalMe);

// Registered before /bookings/:id — otherwise Express would match
// "/bookings/requests" as :id="requests".
router.get("/bookings/requests", authenticateUser, requireClientAccount, requireClientPermission("booking:create"), getMyBookingRequests);
router.post("/bookings/requests", authenticateUser, requireClientAccount, requireClientPermission("booking:create"), createBookingRequest);
router.patch("/bookings/requests/:id/cancel", authenticateUser, requireClientAccount, requireClientPermission("booking:create"), cancelBookingRequest);

router.get("/bookings", authenticateUser, requireClientAccount, requireClientPermission("booking:read"), getPortalBookings);
router.get("/bookings/:id", authenticateUser, requireClientAccount, requireClientPermission("booking:read"), getPortalBooking);

router.post("/bookings/:id/reschedule-request", authenticateUser, requireClientAccount, requireClientPermission("booking:update"), createRescheduleRequest);
router.post("/bookings/:id/cancel-request", authenticateUser, requireClientAccount, requireClientPermission("booking:cancel"), createCancelRequest);
router.get("/bookings/:id/change-requests", authenticateUser, requireClientAccount, requireClientPermission("booking:read"), getBookingChangeRequests);

// Gated inline in the controller (not via requireClientPermission) — which
// action applies depends on the request's own `type`, not a single fixed
// action this route can name upfront.
router.patch("/change-requests/:id/cancel", authenticateUser, requireClientAccount, withdrawJobChangeRequest);

router.get("/quotes", authenticateUser, requireClientAccount, requireClientPermission("quote:read"), getPortalQuotes);
router.get("/quotes/:id", authenticateUser, requireClientAccount, requireClientPermission("quote:read"), getPortalQuote);
router.post("/quotes/:id/accept", authenticateUser, requireClientAccount, requireClientPermission("quote:accept"), acceptPortalQuote);
router.post("/quotes/:id/decline", authenticateUser, requireClientAccount, requireClientPermission("quote:accept"), declinePortalQuote);

router.get("/invoices", authenticateUser, requireClientAccount, requireClientPermission("invoice:read"), getPortalInvoices);
router.get("/invoices/:id", authenticateUser, requireClientAccount, requireClientPermission("invoice:read"), getPortalInvoice);
router.get("/invoices/:id/pdf", authenticateUser, requireClientAccount, requireClientPermission("invoice:read"), downloadPortalInvoicePdf);

// Not in the original spec's permission table — tied to booking:read, see
// clientPermissions.ts.
router.get("/sites", authenticateUser, requireClientAccount, requireClientPermission("booking:read"), getPortalSites);
router.get("/sites/:id", authenticateUser, requireClientAccount, requireClientPermission("booking:read"), getPortalSite);

export default router;
