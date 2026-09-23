// @ts-ignore
import express from "express";
import { acceptRecurringSeries, claimOpenShift, createWorker, declineRecurringSeries, endWorkerBreak, getActiveJob, getJob, getMyJobs, getMyTotalHours, getOpenShifts, getRecurringAssignmentGroups, getWorkerDashboardStats, manuallyAdjustAssignment, markAssignmentNoShow, reviewAssignmentOvertime, reviewOpenShiftClaim, saveExpoPushToken, savePushSubscription, startWorkerBreak, updateAssignmentNote, updateWorkerJobStatus, uploadAssignmentPhoto } from "../controllers/workerController.js"
import { authorizePermissions }
    from "../middleware/authMiddleware.js";
import { requireNotRestricted } from "../middleware/restrictionMiddleware.js";
import upload from "../middleware/multerMiddleware.js";
const router = express.Router();
router
    .route("/").
    post(authorizePermissions("admin", "manager"), createWorker)
    .get(authorizePermissions("worker"), getMyJobs)
router.route("/me/hours").get(authorizePermissions("worker"), getMyTotalHours);
router.route("/stats").get(authorizePermissions("worker"), getWorkerDashboardStats);
router.route("/active-job").get(authorizePermissions("worker"), getActiveJob)
// Registered before the generic "/:id" GET below — otherwise Express would
// match "/recurring-groups" (and "/open-shifts") against ":id" and call
// getJob instead.
router.route("/recurring-groups").get(authorizePermissions("worker"), getRecurringAssignmentGroups);
router.route("/recurring-jobs/:id/accept-all").patch(authorizePermissions("worker"), acceptRecurringSeries);
router.route("/recurring-jobs/:id/decline-all").patch(authorizePermissions("worker"), declineRecurringSeries);
router.route("/open-shifts").get(authorizePermissions("worker"), getOpenShifts);
router.route("/open-shifts/:jobId/claim")
    .post(authorizePermissions("worker"), requireNotRestricted("claim_jobs"), claimOpenShift);
router.route("/:id/status")
.patch(updateWorkerJobStatus);
router.route("/:id/break/start").patch(authorizePermissions("worker"), startWorkerBreak);
router.route("/:id/break/end").patch(authorizePermissions("worker"), endWorkerBreak);
router.route("/:id").get(authorizePermissions("worker"), getJob)
// Managers/admins need these too — they're the ones who actually get the
// overtime-review, auto-close and job-completed push notifications.
router.route("/push-subscription").post(authorizePermissions("worker", "admin", "manager"), savePushSubscription);
router.route("/expo-push-token").post(authorizePermissions("worker", "admin", "manager"), saveExpoPushToken);
router.route("/assignments/:assignmentId/overtime")
    .patch(authorizePermissions("admin", "manager"), reviewAssignmentOvertime);
router.route("/assignments/:assignmentId/manual-adjustment")
    .patch(authorizePermissions("admin", "manager"), manuallyAdjustAssignment);
router.route("/assignments/:assignmentId/no-show")
    .patch(authorizePermissions("admin", "manager"), markAssignmentNoShow);
router.route("/assignments/:assignmentId/claim-review")
    .patch(authorizePermissions("admin", "manager"), reviewOpenShiftClaim);
router.route("/assignments/:assignmentId/note")
    .patch(authorizePermissions("worker"), updateAssignmentNote);
router.route("/assignments/:assignmentId/photos")
    .post(authorizePermissions("worker"), upload.single("photo"), uploadAssignmentPhoto);
export default router;
