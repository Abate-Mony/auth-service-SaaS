// @ts-ignore
import express from "express";
import {
  currentUser,
  getAllUser,
  getStaticUser,
} from "../controllers/userController.js";
import { authorizePermissions } 
from "../middleware/authMiddleware.js";
const router = express.Router();
router
  .route("/current-user")
  .get(authorizePermissions("user", "admin","moderator","worker"), currentUser);
router.route("/allusers").get(authorizePermissions("admin","worker"), getAllUser);
router.route("/users").get(authorizePermissions("admin","manager"), getAllUser);
router.route("/:userId").get(
authorizePermissions("admin"),
getStaticUser);
export default router;
