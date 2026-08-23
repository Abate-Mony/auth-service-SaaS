import { Router } from "express";
import { getCompanySettings, updateCompanySettings } from "../controllers/companyController.js";
import { authorizePermissions } from "../middleware/authMiddleware.js";

const router = Router();

router.route("/settings")
    .get(getCompanySettings)
    .patch(authorizePermissions("admin"), updateCompanySettings);

export default router;
