import { Router } from "express";
import {
    archiveClient,
    createClient,
    deleteClient,
    getAllClients,
    getClient,
    updateClient,
} from "../controllers/clientController.js";
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

export default router;
