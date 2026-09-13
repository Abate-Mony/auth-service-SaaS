import { Router } from "express";
import { createSite, getAllSites, getSite, updateSite, updateSiteStatus } from "../controllers/siteController.js";
import { authorizePermissions } from "../middleware/authMiddleware.js";

const router = Router();

// Site management is an admin/manager operational concern — workers only
// ever see a site's details through their assigned Job (siteSnapshot),
// never by enumerating a company's sites directly.
router.route("/")
    .get(authorizePermissions("admin", "manager"), getAllSites)
    .post(authorizePermissions("admin", "manager"), createSite);

router.route("/:id")
    .get(authorizePermissions("admin", "manager"), getSite)
    .patch(authorizePermissions("admin", "manager"), updateSite);

router.patch("/:id/status", authorizePermissions("admin", "manager"), updateSiteStatus);

export default router;
