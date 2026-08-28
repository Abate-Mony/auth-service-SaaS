// routes/notificationPreferenceRouter.ts

import { Router } from "express";

import {
  getMyNotificationPreferences,
  updateMyNotificationPreferences,
} from "../controllers/notificationPreferenceController.js";

const router = Router();

router.get(
  "/me",
  getMyNotificationPreferences
);

router.patch(
  "/me",
  updateMyNotificationPreferences
);

export default router;