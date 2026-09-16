import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
    cancelQuoteHandler,
    createQuote,
    deleteQuote,
    downloadQuotePdf,
    getAllQuotes,
    getPublicQuote,
    getQuote,
    respondToPublicQuote,
    sendQuoteHandler,
    updateQuote,
} from "../controllers/quoteController.js";
import { authenticateUser, authorizePermissions } from "../middleware/authMiddleware.js";

const router = Router();

// Public routes only — the client isn't logged in, so these can't sit
// behind authenticateUser the way the rest of this router does. Same
// rate-limit shape as invitationRouter's publicInvitationLimiter.
const publicQuoteLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
});

router.get("/public/:token", publicQuoteLimiter, getPublicQuote);
router.post("/public/:token/respond", publicQuoteLimiter, respondToPublicQuote);

router
    .route("/")
    .get(authenticateUser, authorizePermissions("admin", "manager"), getAllQuotes)
    .post(authenticateUser, authorizePermissions("admin", "manager"), createQuote);

router
    .route("/:id")
    .get(authenticateUser, authorizePermissions("admin", "manager"), getQuote)
    .patch(authenticateUser, authorizePermissions("admin", "manager"), updateQuote)
    .delete(authenticateUser, authorizePermissions("admin", "manager"), deleteQuote);

router.get("/:id/pdf", authenticateUser, authorizePermissions("admin", "manager"), downloadQuotePdf);
router.post("/:id/send", authenticateUser, authorizePermissions("admin", "manager"), sendQuoteHandler);
router.patch("/:id/cancel", authenticateUser, authorizePermissions("admin", "manager"), cancelQuoteHandler);

export default router;
