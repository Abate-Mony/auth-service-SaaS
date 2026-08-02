import { Router } from "express";
import { getJobTimeline } from "../controllers/activity_log_controller.js";

const router = Router();


router.route("/:id")
    .get(getJobTimeline)



export default router;