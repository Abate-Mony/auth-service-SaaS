import express from "express"
import rateLimit from "express-rate-limit";
import { forgotPassword, login, loginWithGoogle, logout, mobileLogin, refresh, register, resendVerificationEmail, resetPassword, verifyEmail } from "../controllers/authControler.js";
import { authenticateUser } from "../middleware/authMiddleware.js";
const router=express.Router()

// Unauthenticated by nature (that's the point of a login endpoint) and the
// prime target for credential stuffing / brute force, so it gets a tighter
// limit than the rest of the public auth routes.
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { msg: "Too many login attempts. Please try again later." },
});

router.post("/signup", register);
router.post("/login", loginLimiter, login);
router.post("/login/google",loginWithGoogle)
router.post("/refresh", refresh);
router.post("/logout", logout);
router.post("/verify-email", verifyEmail);
router.post("/resend-verification", authenticateUser, resendVerificationEmail);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);
router.post("/mobile/login", loginLimiter, mobileLogin);
export default router;
