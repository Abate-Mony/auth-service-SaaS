import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requirePlatformRole } from "../middleware/platformAuthMiddleware.js";
import { PLATFORM_ROLES } from "../utils/platformRoles.js";
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
  getPlatformCronJobs,
  runPlatformCronJob,
  getPlatformErrors,
  resolvePlatformError,
  getPlatformAdmins,
  grantPlatformAdmin,
  revokePlatformAdmin,
  getPlatformAnnouncements,
  createPlatformAnnouncement,
  updatePlatformAnnouncement,
  getPlatformMaintenanceStatus,
  enableMaintenanceMode,
  disableMaintenanceMode,
  bulkUpdateCompanyStatus,
  getPlatformMetricsTrend,
} from "../controllers/platformController.js";
import {
  getCompanyNotes,
  addCompanyNote,
  deleteCompanyNote,
  updateCompanyTags,
  extendCompanyTrial,
  retryCompanyPayment,
  getFeatureFlagCatalog,
  updateCompanyFeatureFlags,
  getCompanyApiKeys,
  revokeCompanyApiKey,
  getSupportAccess,
  startSupportAccess,
  endSupportAccess,
  getSupportJobs,
  getSupportInvoices,
  exportCompanyData,
  scheduleCompanyDeletion,
  cancelCompanyDeletion,
  sendUserPasswordReset,
  resendUserVerification,
  changeUserEmail,
  revokeUserSessions,
  sendUserTestNotification,
  moveUserCompany,
  anonymiseUser,
  bulkUpdateCompanyTags,
} from "../controllers/platformSupportController.js";

const router = Router();

// authenticateUser has already run at the mount point (see server.ts, same
// pattern as every other tenant router). requirePlatformRole re-verifies
// platformRole against the database on every request rather than trusting
// the JWT — see platformAuthMiddleware.ts for why that's a deliberate
// deviation from authorizePermissions's usual JWT-only check.
// Every platform role can read. Changes are split by role:
//   SUPPORT  = super_admin + support_admin   (help a customer: notes, resets, access)
//   BILLING  = super_admin + billing_admin   (plans, trials, payments)
//   SUPER    = super_admin only              (destructive / access to the platform itself)
// requirePlatformRole re-checks platformRole from the database on every
// request (see platformAuthMiddleware.ts).
router.use(requirePlatformRole(...PLATFORM_ROLES));
const SUPPORT = requirePlatformRole("super_admin", "support_admin");
const BILLING = requirePlatformRole("super_admin", "billing_admin");
const SUPER = requirePlatformRole("super_admin");

// Tighter limit on state-changing platform routes than the general API gets
// — these are the highest-blast-radius mutations in the app (suspend any
// company, disable any user, override any plan).
const mutationLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });

router.get("/overview", getPlatformOverview);
router.get("/feature-flags", getFeatureFlagCatalog);

router.get("/companies", getPlatformCompanies);
// Bulk routes MUST be registered before the /:companyId/... routes below —
// otherwise Express would match "/companies/bulk/status" against
// "/companies/:companyId/status" first, with companyId="bulk".
router.patch("/companies/bulk/status", SUPER, mutationLimiter, bulkUpdateCompanyStatus);
router.patch("/companies/bulk/tags", SUPPORT, mutationLimiter, bulkUpdateCompanyTags);
router.get("/companies/:companyId", getPlatformCompanyDetail);
router.patch("/companies/:companyId/status", SUPER, mutationLimiter, updateCompanyStatus);
router.patch("/companies/:companyId/plan", BILLING, mutationLimiter, updateCompanyPlanOverride);
router.get("/companies/:companyId/users", getPlatformCompanyUsers);
router.get("/companies/:companyId/usage", getPlatformCompanyUsage);
router.get("/companies/:companyId/email", getPlatformCompanyEmail);

router.get("/companies/:companyId/notes", getCompanyNotes);
router.post("/companies/:companyId/notes", SUPPORT, mutationLimiter, addCompanyNote);
router.delete("/companies/:companyId/notes/:noteId", SUPPORT, mutationLimiter, deleteCompanyNote);
router.patch("/companies/:companyId/tags", SUPPORT, mutationLimiter, updateCompanyTags);
router.post("/companies/:companyId/trial/extend", BILLING, mutationLimiter, extendCompanyTrial);
router.post("/companies/:companyId/billing/retry-payment", BILLING, mutationLimiter, retryCompanyPayment);
router.patch("/companies/:companyId/feature-flags", SUPER, mutationLimiter, updateCompanyFeatureFlags);
router.get("/companies/:companyId/api-keys", getCompanyApiKeys);
router.post("/companies/:companyId/api-keys/:keyId/revoke", SUPPORT, mutationLimiter, revokeCompanyApiKey);
router.get("/companies/:companyId/support-access", SUPPORT, getSupportAccess);
router.post("/companies/:companyId/support-access", SUPPORT, mutationLimiter, startSupportAccess);
router.post("/companies/:companyId/support-access/end", SUPPORT, mutationLimiter, endSupportAccess);
router.get("/companies/:companyId/support/jobs", SUPPORT, getSupportJobs);
router.get("/companies/:companyId/support/invoices", SUPPORT, getSupportInvoices);
router.post("/companies/:companyId/export", SUPER, mutationLimiter, exportCompanyData);
router.post("/companies/:companyId/deletion", SUPER, mutationLimiter, scheduleCompanyDeletion);
router.delete("/companies/:companyId/deletion", SUPER, mutationLimiter, cancelCompanyDeletion);

router.get("/users", getPlatformUsers);
router.get("/users/:userId", getPlatformUserDetail);
router.patch("/users/:userId/status", SUPPORT, mutationLimiter, updateUserStatus);
router.post("/users/:userId/password-reset", SUPPORT, mutationLimiter, sendUserPasswordReset);
router.post("/users/:userId/resend-verification", SUPPORT, mutationLimiter, resendUserVerification);
router.patch("/users/:userId/email", SUPPORT, mutationLimiter, changeUserEmail);
router.post("/users/:userId/sign-out-everywhere", SUPPORT, mutationLimiter, revokeUserSessions);
router.post("/users/:userId/test-notification", SUPPORT, mutationLimiter, sendUserTestNotification);
router.patch("/users/:userId/company", SUPER, mutationLimiter, moveUserCompany);
router.post("/users/:userId/anonymise", SUPER, mutationLimiter, anonymiseUser);

router.post("/email-domains/:companyId/retry-verification", SUPPORT, mutationLimiter, retryEmailDomainVerification);
router.post("/email-domains/:companyId/reset", SUPPORT, mutationLimiter, resetEmailDomain);

// Read-only through the API by construction — no PATCH/DELETE routes exist
// for audit records anywhere in this router.
router.get("/audit", getPlatformAuditList);
router.get("/audit/:eventId", getPlatformAuditDetail);

router.get("/system", getPlatformSystem);
router.get("/system/maintenance", getPlatformMaintenanceStatus);
router.post("/system/maintenance/enable", SUPER, mutationLimiter, enableMaintenanceMode);
router.post("/system/maintenance/disable", SUPER, mutationLimiter, disableMaintenanceMode);

router.get("/metrics/trend", getPlatformMetricsTrend);

router.get("/cron", getPlatformCronJobs);
router.post("/cron/:name/run", SUPER, mutationLimiter, runPlatformCronJob);

router.get("/errors", getPlatformErrors);
router.patch("/errors/:errorId/resolve", SUPPORT, mutationLimiter, resolvePlatformError);

router.get("/admins", SUPER, getPlatformAdmins);
router.post("/admins/grant", SUPER, mutationLimiter, grantPlatformAdmin);
router.post("/admins/:userId/revoke", SUPER, mutationLimiter, revokePlatformAdmin);

router.get("/announcements", getPlatformAnnouncements);
router.post("/announcements", SUPPORT, mutationLimiter, createPlatformAnnouncement);
router.patch("/announcements/:announcementId", SUPPORT, mutationLimiter, updatePlatformAnnouncement);

export default router;
