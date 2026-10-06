import { Router } from "express";
import rateLimit from "express-rate-limit";
import { getPublicQuoteIntakeCompany, submitPublicQuoteIntake } from "../controllers/publicQuoteIntakeController.js";
import { getPublicQuoteWorkflow } from "../controllers/quoteWorkflowController.js";

const router = Router();

// Same shape as quoteRouter's own publicQuoteLimiter — unauthenticated by
// definition, so rate limiting is the only real abuse guard here.
const publicQuoteIntakeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
});

router.get("/:slug", publicQuoteIntakeLimiter, getPublicQuoteIntakeCompany);
router.get("/:slug/workflow", publicQuoteIntakeLimiter, getPublicQuoteWorkflow);
router.post("/:slug", publicQuoteIntakeLimiter, submitPublicQuoteIntake);

export default router;
