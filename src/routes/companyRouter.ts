import { Router } from "express";
import {
    deleteCompanyLogo,
    getCompanyPlan,
    getCompanySettings,
    getPlanCatalog,
    getPublicQuoteLink,
    rotatePublicQuoteLink,
    updateCompanyPlan,
    updateCompanySettings,
    uploadCompanyLogo,
} from "../controllers/companyController.js";
import {
    connectEmailDomain,
    getEmailSettings,
    removeEmailDomain,
    sendTestEmail,
    updateEmailSettings,
    verifyEmailDomain,
} from "../controllers/companyEmailController.js";
import { setDefaultInvoiceTemplate } from "../controllers/invoiceTemplateController.js";
import { createApiKey, getApiKeys, revokeApiKey } from "../controllers/apiKeyController.js";
import { getQuoteWorkflow, publishQuoteWorkflow, saveQuoteWorkflowDraft } from "../controllers/quoteWorkflowController.js";
import { authorizePermissions } from "../middleware/authMiddleware.js";
import { uploadAvatar } from "../middleware/multerMiddleware.js";

const router = Router();

router.route("/settings")
    .get(getCompanySettings)
    .patch(authorizePermissions("admin"), updateCompanySettings);

router.patch("/invoice-template", authorizePermissions("admin"), setDefaultInvoiceTemplate);

// Email & Sending — DNS/domain infrastructure and the address INPRN sends
// as, so every mutation is owner-only (the safest v1 permission model per
// the brief); admin can still view the current setup.
router.route("/email-settings")
    .get(authorizePermissions("admin"), getEmailSettings)
    .patch(authorizePermissions("owner"), updateEmailSettings);

router.route("/email-domain")
    .post(authorizePermissions("owner"), connectEmailDomain)
    .delete(authorizePermissions("owner"), removeEmailDomain);
router.post("/email-domain/verify", authorizePermissions("owner"), verifyEmailDomain);
router.post("/email-domain/test", authorizePermissions("owner"), sendTestEmail);

// External-integration credentials — owner-only to create/revoke (same
// "credentials to outside systems are the most sensitive tier" reasoning
// as email-domain above); admin can view what exists.
router.route("/api-keys")
    .get(authorizePermissions("admin"), getApiKeys)
    .post(authorizePermissions("owner"), createApiKey);
router.delete("/api-keys/:id", authorizePermissions("owner"), revokeApiKey);

router.route("/logo")
    .post(authorizePermissions("admin"), uploadAvatar.single("logo"), uploadCompanyLogo)
    .delete(authorizePermissions("admin"), deleteCompanyLogo);

// The public quote-request link — admin can view it, only owner can
// generate/rotate it (same tier as email-domain/api-keys above: creating
// or changing an externally-shared identifier for the company).
router.get("/public-quote-link", authorizePermissions("admin"), getPublicQuoteLink);
router.post("/public-quote-link/rotate", authorizePermissions("owner"), rotatePublicQuoteLink);

// The quote-request wizard's content — admin can view/edit the draft and
// publish; same tier as /settings above (an operational config, not a
// credential), not owner-restricted like the link/email-domain group.
router.route("/quote-workflow")
    .get(authorizePermissions("admin"), getQuoteWorkflow)
    .put(authorizePermissions("admin"), saveQuoteWorkflowDraft);
router.post("/quote-workflow/publish", authorizePermissions("admin"), publishQuoteWorkflow);

// Registered before "/plan" only as a matter of habit (they're distinct
// literal segments so Express wouldn't actually confuse them) — the
// pricing catalog is the same for every company, no admin gate needed.
router.get("/plans", getPlanCatalog);

router.route("/plan")
    .get(getCompanyPlan)
    .patch(authorizePermissions("admin"), updateCompanyPlan);

export default router;
