import { Router } from "express";
import {
  getMyNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "../controllers/notificationController.js";

const router = Router();

/**
 * @route   GET    /api/v1/notifications?page=&limit=
 * @route   PATCH  /api/v1/notifications/read-all
 * @route   PATCH  /api/v1/notifications/:id/read
 * @desc    A user's own notification inbox — no admin/manager gate beyond
 *          the standard authenticateUser, since every role can have one.
 */
router.get("/", getMyNotifications);
router.patch("/read-all", markAllNotificationsRead);
router.patch("/:id/read", markNotificationRead);

export default router;
