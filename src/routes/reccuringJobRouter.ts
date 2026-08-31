import { Router } from "express";
import { authenticateUser, authorizePermissions } from "../middleware/authMiddleware.js";
import {
  getRecurringJobs,
  getRecurringJob,
  updateRecurringJob,
  cancelRecurringJob,
  reactivateRecurringJob,
} from "../controllers/recurringJobController.js";

const router = Router();

router.use(authenticateUser);

// Managers and admins can see and manage schedules; workers can't
router
  .route("/")
  .get(authorizePermissions("admin", "manager"), getRecurringJobs);

router
  .route("/:id")
  .get(authorizePermissions("admin", "manager"), getRecurringJob)
  .patch(authorizePermissions("admin", "manager"), updateRecurringJob);

// Stops generation. Optionally cancels already-generated future occurrences —
// that's a separate decision, passed as `cancelFutureJobs` in the body.
router.patch(
  "/:id/cancel",
  authorizePermissions("admin", "manager"),
  cancelRecurringJob
);

// Turns a stopped schedule back on and generates the missed window
router.patch(
  "/:id/reactivate",
  authorizePermissions("admin", "manager"),
  reactivateRecurringJob
);

export default router;