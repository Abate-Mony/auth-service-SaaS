import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
    acceptExistingUserInvitation,
    acceptInvitation,
    createInvitation,
    getInvitation,
    getInvitations,
    resendInvitation,
    revokeInvitation,
    updateInvitation,
    validateInvitation,
} from "../controllers/invitationController.js";
import { authenticateUser, authorizePermissions } from "../middleware/authMiddleware.js";

const router = Router();

// Public routes only — the recipient isn't logged in yet, so this can't sit
// behind authenticateUser the way the rest of the API does. Rate-limited
// since both accept a raw token from an unauthenticated caller.
const publicInvitationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
});

router.get("/validate", publicInvitationLimiter, validateInvitation);
router.post("/accept", publicInvitationLimiter, acceptInvitation);

// Existing-account acceptance needs a real session (to know *which*
// account is accepting) — kept as its own endpoint rather than an
// optional-auth hack on /accept.
router.post("/accept-existing", authenticateUser, acceptExistingUserInvitation);

router.post("/", authenticateUser, authorizePermissions("admin", "manager"), createInvitation);
router.get("/", authenticateUser, authorizePermissions("admin", "manager"), getInvitations);
router.get("/:id", authenticateUser, authorizePermissions("admin", "manager"), getInvitation);
router.patch("/:id", authenticateUser, authorizePermissions("admin", "manager"), updateInvitation);
router.post("/:id/resend", authenticateUser, authorizePermissions("admin", "manager"), resendInvitation);
router.patch("/:id/revoke", authenticateUser, authorizePermissions("admin", "manager"), revokeInvitation);

export default router;
