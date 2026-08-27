// @ts-ignore
import express from "express";
import { createWorker, endWorkerBreak, getActiveJob, getJob, getMyJobs, getMyTotalHours, getWorkerDashboardStats, savePushSubscription, startWorkerBreak, updateWorkerJobStatus } from "../controllers/workerController.js"
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
router.route("/:id/break/start").patch(authorizePermissions("worker"), startWorkerBreak);
router.route("/:id/break/end").patch(authorizePermissions("worker"), endWorkerBreak);
router.route("/:id").get(authorizePermissions("worker"), getJob)
router.route("/push-subscription").post(authorizePermissions("worker"), savePushSubscription);
export default router;
