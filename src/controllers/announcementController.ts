import { StatusCodes } from "http-status-codes";
import { getReqUser, MiddlewareFn } from "../interfaces/expresstype.js";
import Company from "../models/company.js";
import PlatformAnnouncement from "../models/PlatformAnnouncement.js";

// GET /announcements/active — the only tenant-facing route for this
// feature. Everything else (create/update/deactivate) is platform-admin-only
// and lives in platformController.ts, gated behind requirePlatformRole.
export const getActiveAnnouncements: MiddlewareFn = async (req, res) => {
  const companyId = getReqUser(req).company_id;
  const now = new Date();

  const company = companyId ? await Company.findById(companyId).select("plan").lean() : null;

  const candidates = await PlatformAnnouncement.find({
    isActive: true,
    startsAt: { $lte: now },
    $or: [{ endsAt: null }, { endsAt: { $gte: now } }],
  })
    // Severity isn't alphabetically orderable ("critical" < "info" <
    // "warning"), so this only orders by recency — AnnouncementBanner.tsx
    // on the frontend re-ranks by actual severity before picking which one
    // to show first.
    .sort({ createdAt: -1 })
    .lean();

  const matching = candidates.filter(a => {
    if (a.audience === "all") return true;
    if (a.audience === "plan") return !!company && a.targetPlans.includes(company.plan);
    if (a.audience === "company") return !!companyId && a.targetCompanies.some(id => id.toString() === companyId.toString());
    return false;
  });

  res.status(StatusCodes.OK).json({
    success: true,
    data: matching.map(a => ({
      id: a._id.toString(),
      message: a.message,
      severity: a.severity,
    })),
  });
};
