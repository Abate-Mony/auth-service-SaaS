// @ts-ignore
import { Router } from "express";
import {
  createJob,
  deleteJob,
  duplicateJob,
  getAllJobs,
  getJob,
  updateJob,
} from "../controllers/jobController.js";
import { authorizePermissions } from "../middleware/authMiddleware.js";

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


export default router;