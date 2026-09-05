// @ts-ignore
import express from "express";
import {
  currentUser,
  getAllUser,
  getStaticUser,
  getWorkerStats,
} from "../controllers/userController.js";
import { authorizePermissions }
from "../middleware/authMiddleware.js";
import { getDashboardStats } from "../controllers/dashboardStat.js";
const router = express.Router();
router
  .route("/current-user")
  .get(authorizePermissions("user", "admin","manager","worker"), currentUser);
router.route("/allusers").get(authorizePermissions("admin","worker"), getAllUser);
router.route("/users").get(authorizePermissions("admin","manager"), getAllUser);
router.route("/dashboardstats").get(authorizePermissions("admin","manager"), getDashboardStats);
router.route("/:id/stats").get(authorizePermissions("admin", "manager"), getWorkerStats);
router.route("/:userId").get(
authorizePermissions("admin"),
getStaticUser);
export default router;
