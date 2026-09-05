import { Router } from "express";
import {
    createRestriction,
    getMyRestriction,
    getRestriction,
    getRestrictions,
    liftRestriction,
    respondToAppeal,
    submitAppeal,
    updateRestriction,
} from "../controllers/userRestrictionController.js";
import { authenticateUser, authorizePermissions } from "../middleware/authMiddleware.js";
import { loadRestriction } from "../middleware/restrictionMiddleware.js";

const router = Router();

router.use(authenticateUser);
router.use(loadRestriction);

// The user's own restriction and appeal — any role, and these must stay
// reachable no matter how restricted the caller is (see restrictionMiddleware).
router.get("/me", getMyRestriction);
router.post("/me/appeal", submitAppeal);

router
    .route("/")
    .get(authorizePermissions("admin", "manager"), getRestrictions)
    .post(authorizePermissions("admin", "manager"), createRestriction);

router
    .route("/:id")
    .get(authorizePermissions("admin", "manager"), getRestriction)
    .patch(authorizePermissions("admin", "manager"), updateRestriction);

router.patch("/:id/lift", authorizePermissions("admin", "manager"), liftRestriction);
router.patch("/:id/appeal", authorizePermissions("admin", "manager"), respondToAppeal);

export default router;
