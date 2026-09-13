import { Router } from "express";
import { deleteCompanyLogo, getCompanyPlan, getCompanySettings, getPlanCatalog, updateCompanyPlan, updateCompanySettings, uploadCompanyLogo } from "../controllers/companyController.js";
import { authorizePermissions } from "../middleware/authMiddleware.js";
import upload from "../middleware/multerMiddleware.js";

const router = Router();

router.route("/settings")
    .get(getCompanySettings)
    .patch(authorizePermissions("admin"), updateCompanySettings);

router.route("/logo")
    .post(authorizePermissions("admin"), upload.single("logo"), uploadCompanyLogo)
    .delete(authorizePermissions("admin"), deleteCompanyLogo);

// Registered before "/plan" only as a matter of habit (they're distinct
// literal segments so Express wouldn't actually confuse them) — the
// pricing catalog is the same for every company, no admin gate needed.
router.get("/plans", getPlanCatalog);

router.route("/plan")
    .get(getCompanyPlan)
    .patch(authorizePermissions("admin"), updateCompanyPlan);

export default router;
