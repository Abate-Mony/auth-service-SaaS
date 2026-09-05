import express from "express"
import { forgotPassword, login, loginWithGoogle, logout, mobileLogin, refresh, register, resendVerificationEmail, resetPassword, verifyEmail } from "../controllers/authControler.js";
import { authenticateUser } from "../middleware/authMiddleware.js";
const router=express.Router()
router.post("/signup", register);
router.post("/login", login);
router.post("/login/google",loginWithGoogle)
router.post("/refresh", refresh);
router.post("/logout", logout);
router.post("/verify-email", verifyEmail);
router.post("/resend-verification", authenticateUser, resendVerificationEmail);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);
router.post("/mobile/login", mobileLogin);
export default router;
