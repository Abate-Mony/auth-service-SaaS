// routes/externalRouter.ts
//
// The public-facing surface for external integrations (a company's own
// booking website, etc.) — API-key authenticated, never a user session.
// Mounted separately from every other router in server.ts specifically so
// it's never accidentally wrapped in authenticateUser.
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticateApiKey } from "../middleware/apiKeyAuthMiddleware.js";
import { getExternalClients, getExternalSites, getExternalSchedule, createExternalJob } from "../controllers/externalController.js";

const router = Router();

// Generous enough for a real booking website's traffic, capped well below
// abuse levels — same reasoning as the AI routes' own limiter.
const externalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(externalLimiter, authenticateApiKey);

router.get("/clients", getExternalClients);
router.get("/sites", getExternalSites);
router.get("/schedule", getExternalSchedule);
router.post("/jobs", createExternalJob);

export default router;
