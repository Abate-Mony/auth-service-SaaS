import { Router } from "express";
import { deleteCompanyLogo, getCompanyPlan, getCompanySettings, getPlanCatalog, updateCompanyPlan, updateCompanySettings, uploadCompanyLogo } from "../controllers/companyController.js";
import {
    connectEmailDomain,
    getEmailSettings,
    removeEmailDomain,
    sendTestEmail,
    updateEmailSettings,
    verifyEmailDomain,
} from "../controllers/companyEmailController.js";
import { setDefaultInvoiceTemplate } from "../controllers/invoiceTemplateController.js";
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

router.route("/logo")
    .post(authorizePermissions("admin"), uploadAvatar.single("logo"), uploadCompanyLogo)
    .delete(authorizePermissions("admin"), deleteCompanyLogo);

// Registered before "/plan" only as a matter of habit (they're distinct
// literal segments so Express wouldn't actually confuse them) — the
// pricing catalog is the same for every company, no admin gate needed.
router.get("/plans", getPlanCatalog);

router.route("/plan")
    .get(getCompanyPlan)
    .patch(authorizePermissions("admin"), updateCompanyPlan);

export default router;
