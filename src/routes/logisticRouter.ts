// import { Router } from "express";
// const router = Router();
// import {
//   createLogistic,
//   deleteLogistic,
//   getLogistics,
//   getStaticLogistic,
//   updateLogistic,
//   showStats,
// } from "../controllers/logisticController.js";
// import {
//   authenticateUser,
//   authorizePermissions,
// } from "../middleware/authMiddleware.js";
// import { USER_ROLES } from "../utils/constant.js";
// import upload from "../middleware/multerMiddleware.js";
// import { paginationMiddleware } from "../middleware/paginationMiddleware.js";
// router.post(
//   "/new",
//   authenticateUser,
//   authorizePermissions(USER_ROLES.user, USER_ROLES.admin),
//   upload.array("uploadedImages", 10),
//   createLogistic
// );
// router.get("/all", authenticateUser, paginationMiddleware, getLogistics);
// router.get("/", getStaticLogistic);
// router.delete("/delete/:id", authenticateUser, deleteLogistic);
// router.patch(
//   "/update/:tracking_number",
//   authenticateUser,
//   authorizePermissions("user", "admin"),
//   updateLogistic
// );
// router.get(
//   "/stats",
//   authenticateUser,
//   authorizePermissions("admin", "user"),
//   showStats
// );
// export default router;
