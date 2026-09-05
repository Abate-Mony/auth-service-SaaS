import { Router } from "express";
import { downloadMyTimesheetPdf, downloadWorkerTimesheetPdf, getMyTimesheet, getWorkerTimesheet } from "../controllers/timesheetController.js";
import { requireNotRestricted } from "../middleware/restrictionMiddleware.js";
import { authorizePermissions } from "../middleware/authMiddleware.js";

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
    requireNotRestricted("view_timesheets"),
    getMyTimesheet
)
router.get(
    "/me/pdf",
    downloadMyTimesheetPdf
);

/**
 * @route   GET /api/v1/timesheets/:id
 * @desc    Admin/manager views a specific worker's timesheet summary on-screen
 * @access  Admin, Manager
 *
 * Query:
 * ?period=weekly|biweekly|monthly (default weekly)
 */
router.get(
    "/:id",
    authorizePermissions("admin", "manager"),
    getWorkerTimesheet
);

/**
 * @route   GET /api/v1/timesheets/:id/pdf
 * @desc    Admin/manager downloads a specific worker's timesheet as PDF
 * @access  Admin, Manager
 *
 * Registered after the literal "/me/pdf" above, so "me" is never captured
 * as the :id param.
 *
 * Query:
 * ?startDate=2026-08-01&endDate=2026-08-14
 */
router.get(
    "/:id/pdf",
    authorizePermissions("admin", "manager"),
    downloadWorkerTimesheetPdf
);

export default router;