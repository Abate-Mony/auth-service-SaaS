// @ts-ignore
import express from "express";
import { createWorker, getMyJobs } from "../controllers/workerController.js"
import { authorizePermissions }
    from "../middleware/authMiddleware.js";
import { getJob } from "../controllers/jobController.js";
const router = express.Router();
router
    .route("/").
    post(authorizePermissions("admin", "moderator"), createWorker)
    .get(authorizePermissions("worker"),getMyJobs)
    router.route("/:id").get(authorizePermissions("worker"),getJob)
export default router;
