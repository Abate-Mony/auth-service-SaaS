import { ServiceUnavailableError } from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import PlatformSettings from "../models/PlatformSettings.js";

// Single chokepoint for the emergency "take the whole tenant-facing app
// down" kill switch — mounted once in server.ts, before every router,
// instead of repeating enforceCompanyStatus's per-router pattern. A full
// block (not a partial read-only mode) on purpose: no "disable every
// mutating form" infrastructure exists anywhere in the frontend to build a
// true read-only degrade safely, so this is the simplest honest thing it
// can do.
//
// Deliberately uncached, same tradeoff this codebase already makes in
// enforceCompanyStatus/loadRestriction (one extra indexed findOne per
// request, in exchange for the flag taking effect on every instance's very
// next request — a cached flag risks one instance still serving traffic
// after another instance disabled maintenance mode).
//
// Allowlisted so platform admins can always reach the tools that turn this
// back off, and so Stripe's webhook retries aren't silently swallowed.
const MAINTENANCE_ALLOWLIST = [
  "/api/v1/platform",
  "/api/v1/auth",
  "/api/v1/health",
  "/api/v1/plans",
  "/api/v1/system/maintenance",
];

export const enforceMaintenanceMode: MiddlewareFn = async (req, _res, next) => {
  if (req.method === "POST" && req.originalUrl.startsWith("/api/v1/stripe/webhook")) {
    return next();
  }
  if (MAINTENANCE_ALLOWLIST.some(path => req.originalUrl.startsWith(path))) {
    return next();
  }

  const settings = await PlatformSettings.findOne({ key: "global" }).select("maintenanceMode").lean();
  if (settings?.maintenanceMode?.enabled) {
    throw new ServiceUnavailableError(
      settings.maintenanceMode.message || "OnClockly is temporarily down for maintenance. Please try again shortly.",
      "MAINTENANCE_MODE"
    );
  }

  next();
};
