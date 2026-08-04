import express from "express"
import { getCalendarJobs } from "../controllers/calendarController.js"
const router = express.Router()
router.route("/").get(
    getCalendarJobs
)
export default router 