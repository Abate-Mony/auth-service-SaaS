import { Router } from "express";
import rateLimit from "express-rate-limit";

import { generateJobDraftHandler, generateDashboardInsightsHandler } from "../controllers/aiController.js";
import { authorizePermissions } from "../middleware/authMiddleware.js";

const router = Router();

// Each call is a real, billed LLM request — cap it well below abuse levels
// but generously above normal manager usage (creating a handful of jobs).
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/job-draft", aiLimiter, authorizePermissions("admin", "manager"), generateJobDraftHandler);
router.get("/dashboard-insights", aiLimiter, authorizePermissions("admin", "manager"), generateDashboardInsightsHandler);

export default router;
