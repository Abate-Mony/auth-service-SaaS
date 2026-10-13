import { Router } from "express";
import {
    getBookingRequests,
    getBookingRequest,
    declineBookingRequest,
} from "../controllers/bookingRequestController.js";
import { authorizePermissions } from "../middleware/authMiddleware.js";

// authenticateUser/loadRestriction/enforceCompanyStatus applied at the
// mount point in server.ts, same as every other staff route group — not
// duplicated here. No approve route: see maybeApproveBookingRequest in
// jobController.ts for why approval only ever happens via creating a Job.
const router = Router();

router.use(authorizePermissions("admin", "manager"));

router.get("/", getBookingRequests);
router.get("/:id", getBookingRequest);
router.patch("/:id/decline", declineBookingRequest);

export default router;
