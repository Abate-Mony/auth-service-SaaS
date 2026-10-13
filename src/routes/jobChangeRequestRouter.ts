import { Router } from "express";
import {
    getJobChangeRequests,
    getJobChangeRequest,
    declineJobChangeRequest,
    approveCancelJobChangeRequest,
} from "../controllers/jobChangeRequestController.js";
import { authorizePermissions } from "../middleware/authMiddleware.js";
import { MANAGEMENT_ROLES } from "../utils/roles.js";

// authenticateUser/loadRestriction/enforceCompanyStatus applied at the
// mount point in server.ts, same as every other staff route group. No
// approve-reschedule route — see maybeApproveJobChangeRequest in
// jobController.ts for why that approval only ever happens via editing
// the job itself.
const router = Router();

router.use(authorizePermissions(...MANAGEMENT_ROLES));

router.get("/", getJobChangeRequests);
router.get("/:id", getJobChangeRequest);
router.patch("/:id/decline", declineJobChangeRequest);
router.patch("/:id/approve-cancel", approveCancelJobChangeRequest);

export default router;
