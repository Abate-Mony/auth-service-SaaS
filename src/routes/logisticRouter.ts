import { Router } from "express";
const router = Router();
import {
  createLogistic,
  deleteLogistic,
  getLogistics,
  getStaticLogistic,
} from "../controllers/logisticController.js";
import {
  authenticateUser,
  authorizePermissions,
} from "../middleware/authMiddleware.js";
import { USER_ROLES } from "../utils/constant.js";
import upload from "../middleware/multerMiddleware.js";
router.post(
  "/new",
  authenticateUser,
  authorizePermissions(USER_ROLES.user, USER_ROLES.admin),
  upload.array("uploadedImages", 10),
  createLogistic
);
router.get("/all",authenticateUser, getLogistics);
router.get("/", getStaticLogistic);
router.delete("/delete", authenticateUser, deleteLogistic);
export default router;
