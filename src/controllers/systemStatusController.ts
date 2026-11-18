import { StatusCodes } from "http-status-codes";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import PlatformSettings from "../models/PlatformSettings.js";

// GET /api/v1/system/maintenance — public, unauthenticated. Polled by
// MaintenancePage.tsx on the frontend to know when a blocked tenant can be
// sent back. Returns only what a logged-out visitor is allowed to see —
// never enabledBy/enabledAt, which stay platform-admin-only via
// getPlatformMaintenanceStatus in platformController.ts.
export const getMaintenanceStatusPublic: MiddlewareFn = async (_req, res) => {
  const settings = await PlatformSettings.findOne({ key: "global" })
    .select("maintenanceMode.enabled maintenanceMode.message")
    .lean();
  res.status(StatusCodes.OK).json({
    enabled: !!settings?.maintenanceMode?.enabled,
    message: settings?.maintenanceMode?.message ?? null,
  });
};
