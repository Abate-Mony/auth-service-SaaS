// @ts-ignore
import { Router } from "express";
import {
  createJob,
  deleteJob,
  deleteJobAttachment,
  duplicateJob,
  getAllJobs,
  getJob,
  updateJob,
  uploadJobAttachment,
} from "../controllers/jobController.js";
import { authorizePermissions } from "../middleware/authMiddleware.js";
import upload from "../middleware/multerMiddleware.js";

const router = Router();

router.route("/")
  .get(getAllJobs)
  .post(createJob);
 router.route("/duplicate-job/:id").
 post(authorizePermissions("admin","manager"),duplicateJob)
router.route("/:id")
  .get(getJob)
  .patch(updateJob)
  .delete(deleteJob);

router.route("/:id/attachment")
  .post(authorizePermissions("admin", "manager"), upload.single("attachment"), uploadJobAttachment)
  .delete(authorizePermissions("admin", "manager"), deleteJobAttachment);


export default router;