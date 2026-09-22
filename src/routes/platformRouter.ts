import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requirePlatformRole } from "../middleware/platformAuthMiddleware.js";
import {
  getPlatformOverview,
  getPlatformCompanies,
  getPlatformCompanyDetail,
  getPlatformCompanyUsers,
  getPlatformCompanyUsage,
  getPlatformCompanyEmail,
  getPlatformUsers,
  getPlatformUserDetail,
  updateCompanyStatus,
  updateCompanyPlanOverride,
  updateUserStatus,
  retryEmailDomainVerification,
  resetEmailDomain,
  getPlatformAuditList,
  getPlatformAuditDetail,
  getPlatformSystem,
} from "../controllers/platformController.js";

const router = Router();

// authenticateUser has already run at the mount point (see server.ts, same
// pattern as every other tenant router). requirePlatformRole re-verifies
// platformRole against the database on every request rather than trusting
// the JWT — see platformAuthMiddleware.ts for why that's a deliberate
// deviation from authorizePermissions's usual JWT-only check.
router.use(requirePlatformRole("super_admin"));

// Tighter limit on state-changing platform routes than the general API gets
// — these are the highest-blast-radius mutations in the app (suspend any
// company, disable any user, override any plan).
const mutationLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });

router.get("/overview", getPlatformOverview);

router.get("/companies", getPlatformCompanies);
router.get("/companies/:companyId", getPlatformCompanyDetail);
router.patch("/companies/:companyId/status", mutationLimiter, updateCompanyStatus);
router.patch("/companies/:companyId/plan", mutationLimiter, updateCompanyPlanOverride);
router.get("/companies/:companyId/users", getPlatformCompanyUsers);
router.get("/companies/:companyId/usage", getPlatformCompanyUsage);
router.get("/companies/:companyId/email", getPlatformCompanyEmail);

router.get("/users", getPlatformUsers);
router.get("/users/:userId", getPlatformUserDetail);
router.patch("/users/:userId/status", mutationLimiter, updateUserStatus);

router.post("/email-domains/:companyId/retry-verification", mutationLimiter, retryEmailDomainVerification);
router.post("/email-domains/:companyId/reset", mutationLimiter, resetEmailDomain);

// Read-only through the API by construction — no PATCH/DELETE routes exist
// for audit records anywhere in this router.
router.get("/audit", getPlatformAuditList);
router.get("/audit/:eventId", getPlatformAuditDetail);

router.get("/system", getPlatformSystem);

export default router;
