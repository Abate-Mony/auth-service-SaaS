import { Router } from "express";
import {
    archiveClient,
    createClient,
    deleteClient,
    getAllClients,
    getClient,
    updateClient,
} from "../controllers/clientController.js";
import {
    createClientPortalInvitation,
    getClientPortalUsers,
    updateClientPortalUser,
    resendClientPortalInvitation,
    revokeClientPortalInvitation,
} from "../controllers/clientPortalInvitationController.js";
import { authorizePermissions } from "../middleware/authMiddleware.js";

// authenticateUser is applied at the mount point in server.ts, same as
// every other route group in this app — not duplicated here.
const router = Router();

router
    .route("/")
    .get(authorizePermissions("admin", "manager"), getAllClients)
    .post(authorizePermissions("admin", "manager"), createClient);

router
    .route("/:id")
    .get(authorizePermissions("admin", "manager"), getClient)
    .patch(authorizePermissions("admin", "manager"), updateClient)
    .delete(authorizePermissions("admin"), deleteClient);

router.patch("/:id/status", authorizePermissions("admin", "manager"), archiveClient);

// Client portal access management — invite-only, staff-facing.
router.post("/:id/portal-users/invite", authorizePermissions("admin", "manager"), createClientPortalInvitation);
router.get("/:id/portal-users", authorizePermissions("admin", "manager"), getClientPortalUsers);
router.patch("/:id/portal-users/:userId", authorizePermissions("admin", "manager"), updateClientPortalUser);
router.post("/:id/portal-invitations/:inviteId/resend", authorizePermissions("admin", "manager"), resendClientPortalInvitation);
router.patch("/:id/portal-invitations/:inviteId/revoke", authorizePermissions("admin", "manager"), revokeClientPortalInvitation);

export default router;
