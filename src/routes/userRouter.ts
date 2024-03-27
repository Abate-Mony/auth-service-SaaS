import express from "express";
import { currentUser } from "../controllers/userController.js";
import { authorizePermissions } from "../middleware/authMiddleware.js";
const router = express.Router();
router
  .route("/current-user")
  .get(authorizePermissions("user", "admin"), currentUser);
export default router;
