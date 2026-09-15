// @ts-ignore
import express from "express";
import {
  currentUser,
  deleteMyPhoto,
  getAllUser,
  getStaticUser,
  getWorkerStats,
  updateCurrentUser,
  uploadMyPhoto,
} from "../controllers/userController.js";
import { authorizePermissions }
from "../middleware/authMiddleware.js";
import { getDashboardStats } from "../controllers/dashboardStat.js";
import { uploadAvatar } from "../middleware/multerMiddleware.js";
const router = express.Router();
router
  .route("/current-user")
  .get(authorizePermissions("user", "admin","manager","worker"), currentUser)
  .patch(authorizePermissions("user", "admin","manager","worker"), updateCurrentUser);
router
  .route("/current-user/photo")
  .post(authorizePermissions("user", "admin", "manager", "worker"), uploadAvatar.single("photo"), uploadMyPhoto)
  .delete(authorizePermissions("user", "admin", "manager", "worker"), deleteMyPhoto);
router.route("/allusers").get(authorizePermissions("admin","worker"), getAllUser);
router.route("/users").get(authorizePermissions("admin","manager"), getAllUser);
router.route("/dashboardstats").get(authorizePermissions("admin","manager"), getDashboardStats);
router.route("/:id/stats").get(authorizePermissions("admin", "manager"), getWorkerStats);
router.route("/:userId").get(
authorizePermissions("admin"),
getStaticUser);
export default router;
