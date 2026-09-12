import { Router } from "express";
import { getCompanyPlan, getCompanySettings, getPlanCatalog, updateCompanyPlan, updateCompanySettings } from "../controllers/companyController.js";
import { authorizePermissions } from "../middleware/authMiddleware.js";

const router = Router();

router.route("/settings")
    .get(getCompanySettings)
    .patch(authorizePermissions("admin"), updateCompanySettings);

// Registered before "/plan" only as a matter of habit (they're distinct
// literal segments so Express wouldn't actually confuse them) — the
// pricing catalog is the same for every company, no admin gate needed.
router.get("/plans", getPlanCatalog);

router.route("/plan")
    .get(getCompanyPlan)
    .patch(authorizePermissions("admin"), updateCompanyPlan);

export default router;
