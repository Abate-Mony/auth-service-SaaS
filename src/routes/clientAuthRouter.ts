import express from "express";
import rateLimit from "express-rate-limit";
import { clientLogin, clientMobileLogin } from "../controllers/clientAuthController.js";
import { refresh, logout } from "../controllers/authControler.js";

const router = express.Router();

// Same shape as authRouter.ts's own loginLimiter — a dedicated instance,
// not a shared one, so staff and client login attempts are rate-limited
// independently of each other.
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { msg: "Too many login attempts. Please try again later." },
});

router.post("/login", loginLimiter, clientLogin);
router.post("/mobile-login", loginLimiter, clientMobileLogin);
// refresh/logout are role-agnostic and already shared by the staff and
// mobile flows — reused directly rather than reimplemented.
router.post("/refresh", refresh);
router.post("/logout", logout);

export default router;
