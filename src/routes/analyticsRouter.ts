import { Router } from "express";
import { getAnalytics } from "../controllers/analyticsController.js";
import { authorizePermissions } from "../middleware/authMiddleware.js";

const router = Router();

/**
 * @route   GET /api/v1/analytics?range=7d|30d|90d|year
 * @desc    Company-wide analytics for the Analytics dashboard page
 * @access  Admin, Manager
 */
router.get("/", authorizePermissions("admin", "manager"), getAnalytics);

export default router;
