import { Router } from "express";
import { downloadMyTimesheetPdf, getMyTimesheet } from "../controllers/timesheetController.js";

const router = Router();

/**
 * @route   GET /api/v1/timesheets/me/pdf
 * @desc    Download logged-in user's timesheet as PDF
 * @access  Private
 *
 * Query:
 * ?startDate=2026-08-01&endDate=2026-08-14
 */
router.get("/",
    getMyTimesheet
)
router.get(
    "/me/pdf",
    downloadMyTimesheetPdf
);

export default router;