// @ts-ignore
import express from "express";
import { createWorker, getJob, getMyJobs, updateWorkerJobStatus } from "../controllers/workerController.js"
import { authorizePermissions }
    from "../middleware/authMiddleware.js";
const router = express.Router();
router
    .route("/").
    post(authorizePermissions("admin", "worker"), createWorker)
    .get(authorizePermissions("worker"), getMyJobs)
router.route("/:id").get(authorizePermissions("worker"), getJob)
  router.route("/:id/status")
  .patch(updateWorkerJobStatus);
export default router;
