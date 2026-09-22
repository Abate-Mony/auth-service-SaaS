import { MiddlewareFn } from "../interfaces/expresstype.js";
import { UnauthorizedError } from "../errors/customErrors.js";
import Company from "../models/company.js";

// Runs after authenticateUser on every tenant route (see server.ts). A
// company's `status` (src/models/company.ts) is only ever changed through
// the platform admin API — this is what actually makes that field mean
// anything, rather than just being a database badge nobody reads.
//
// Admin/owner users have no `company_id` on their JWT until a company is
// created (see userModel.ts's `company` field), so this is a no-op until
// then — nothing to enforce yet.
export const enforceCompanyStatus: MiddlewareFn = async (req, _res, next) => {
  if (!req.user?.company_id) {
    next();
    return;
  }

  const company = await Company.findById(req.user.company_id).select("status");
  if (company && company.status !== "active") {
    throw new UnauthorizedError(
      company.status === "suspended"
        ? "This company's account is suspended. Contact support for help."
        : "This company's account has been disabled."
    );
  }

  next();
};
