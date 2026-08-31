import { Router } from "express";
import {
    cancelRecurringJob,
    getRecurringJob,
    getRecurringJobs,
    reactivateRecurringJob,
    updateRecurringJob,
} from "../controllers/recurringJobController.js";
import { authorizePermissions } from "../middleware/authMiddleware.js";

const router = Router();

router.use(authorizePermissions("admin", "manager"));

router.get("/", getRecurringJobs);
router.get("/:id", getRecurringJob);
router.patch("/:id", updateRecurringJob);
router.patch("/:id/cancel", cancelRecurringJob);
router.patch("/:id/reactivate", reactivateRecurringJob);

export default router;
