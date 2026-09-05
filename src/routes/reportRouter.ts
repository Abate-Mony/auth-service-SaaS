import { Router } from "express";
import {
  getReportsOverview,
  getReportsPayroll,
  getReportsTimesheets,
  getReportsPerformance,
} from "../controllers/reportController.js";
import { authorizePermissions } from "../middleware/authMiddleware.js";

const router = Router();

/**
 * @route   GET /api/v1/reports/overview?start=&end=
 * @route   GET /api/v1/reports/payroll?start=&end=
 * @route   GET /api/v1/reports/timesheets?start=&end=
 * @route   GET /api/v1/reports/performance?start=&end=
 * @access  Admin, Manager
 *
 * start/end are inclusive calendar dates (YYYY-MM-DD) — the Reports page's
 * month picker sends the selected month's first/last day.
 */
router.get("/overview", authorizePermissions("admin", "manager"), getReportsOverview);
router.get("/payroll", authorizePermissions("admin", "manager"), getReportsPayroll);
router.get("/timesheets", authorizePermissions("admin", "manager"), getReportsTimesheets);
router.get("/performance", authorizePermissions("admin", "manager"), getReportsPerformance);

export default router;
