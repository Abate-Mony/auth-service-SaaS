import express from "express"
const router=express.Router()
import { login, logout,register } from "../controllers/authControler.js";
router.post("/signup", register);
router.post("/login", login);
router.get("/logout", logout);
export default router;
