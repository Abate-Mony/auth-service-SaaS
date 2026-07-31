import express from "express"
import { login, loginWithGoogle, logout,register } from "../controllers/authControler.js";
const router=express.Router()
router.post("/signup", register);
router.post("/login", login);
router.post("/login/google",loginWithGoogle)
router.get("/logout", logout);
export default router;
