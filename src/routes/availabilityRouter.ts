// @ts-ignore
import express from "express";
import { getJobAvailability, getMyAvailability, updateMyAvailability } from "../controllers/availabilityController.js";
import { authorizePermissions } from "../middleware/authMiddleware.js";

const router = express.Router();

router.route("/me")
    .get(authorizePermissions("worker"), getMyAvailability)
    .put(authorizePermissions("worker"), updateMyAvailability);

router.route("/jobs/:jobId")
    .get(authorizePermissions("admin", "manager"), getJobAvailability);

export default router;
