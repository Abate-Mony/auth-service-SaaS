// @ts-ignore
import express from "express";
import { createWorker, getActiveJob, getJob, getMyJobs, getMyTotalHours, getWorkerDashboardStats, updateWorkerJobStatus } from "../controllers/workerController.js"
import { authorizePermissions }
    from "../middleware/authMiddleware.js";
const router = express.Router();
router
    .route("/").
    post(authorizePermissions("admin", "manager"), createWorker)
    .get(authorizePermissions("worker"), getMyJobs)
router.route("/me/hours").get(authorizePermissions("worker"), getMyTotalHours);
router.route("/stats").get(authorizePermissions("worker"), getWorkerDashboardStats);
router.route("/active-job").get(authorizePermissions("worker"), getActiveJob)
router.route("/:id/status")
.patch(updateWorkerJobStatus);
router.route("/:id").get(authorizePermissions("worker"), getJob)
export default router;
