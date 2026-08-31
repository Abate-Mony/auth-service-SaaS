// @ts-ignore
import express from "express";
import { acceptRecurringSeries, createWorker, declineRecurringSeries, endWorkerBreak, getActiveJob, getJob, getMyJobs, getMyTotalHours, getRecurringAssignmentGroups, getWorkerDashboardStats, reviewAssignmentOvertime, savePushSubscription, startWorkerBreak, updateWorkerJobStatus } from "../controllers/workerController.js"
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
// Registered before the generic "/:id" GET below — otherwise Express would
// match "/recurring-groups" against ":id" and call getJob instead.
router.route("/recurring-groups").get(authorizePermissions("worker"), getRecurringAssignmentGroups);
router.route("/recurring-jobs/:id/accept-all").patch(authorizePermissions("worker"), acceptRecurringSeries);
router.route("/recurring-jobs/:id/decline-all").patch(authorizePermissions("worker"), declineRecurringSeries);
router.route("/:id/status")
.patch(updateWorkerJobStatus);
router.route("/:id/break/start").patch(authorizePermissions("worker"), startWorkerBreak);
router.route("/:id/break/end").patch(authorizePermissions("worker"), endWorkerBreak);
router.route("/:id").get(authorizePermissions("worker"), getJob)
router.route("/push-subscription").post(authorizePermissions("worker"), savePushSubscription);
router.route("/assignments/:assignmentId/overtime")
    .patch(authorizePermissions("admin", "manager"), reviewAssignmentOvertime);
export default router;
