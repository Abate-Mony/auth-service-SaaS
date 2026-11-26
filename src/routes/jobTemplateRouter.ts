import { Router } from "express";
import {
    createJobTemplate, createTemplateFromJob, deleteJobTemplate, getJobTemplate, getJobTemplates,
    markJobTemplateUsed, updateJobTemplate,
} from "../controllers/jobTemplateController.js";
import { authorizePermissions } from "../middleware/authMiddleware.js";

const router = Router();
const staff = authorizePermissions("admin", "manager");

router.route("/").get(staff, getJobTemplates).post(staff, createJobTemplate);
router.post("/from-job/:jobId", staff, createTemplateFromJob);
router.post("/:id/used", staff, markJobTemplateUsed);
router.route("/:id").get(staff, getJobTemplate).patch(staff, updateJobTemplate).delete(staff, deleteJobTemplate);

export default router;
