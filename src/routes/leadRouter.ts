import { Router } from "express";
import {
    getAllLeads,
    getLeadSummary,
    getLostLeads,
    getConvertedLeads,
    createLead,
    getLead,
    updateLead,
    changeLeadStage,
    assignLead,
    updateFollowUp,
    markContacted,
    convertLead,
    markLeadLost,
    restoreLead,
    archiveLead,
    sendLeadQuote,
} from "../controllers/leadController.js";
import { authorizePermissions } from "../middleware/authMiddleware.js";

// authenticateUser is applied at the mount point in server.ts, same as
// every other route group in this app — not duplicated here. Leads are a
// CRM concept owned by sales-facing roles only — workers never get access.
const router = Router();

router.use(authorizePermissions("owner", "admin", "manager"));

// Static sub-paths before "/:id" — otherwise Express would try to treat
// "summary"/"lost"/"converted" as a lead id.
router.get("/summary", getLeadSummary);
router.get("/lost", getLostLeads);
router.get("/converted", getConvertedLeads);

router
    .route("/")
    .get(getAllLeads)
    .post(createLead);

router
    .route("/:id")
    .get(getLead)
    .patch(updateLead)
    .delete(archiveLead);

router.patch("/:id/stage", changeLeadStage);
router.patch("/:id/assign", assignLead);
router.patch("/:id/follow-up", updateFollowUp);
router.patch("/:id/contacted", markContacted);
router.post("/:id/convert", convertLead);
router.post("/:id/lost", markLeadLost);
router.post("/:id/restore", restoreLead);
router.post("/:id/send-quote", sendLeadQuote);

export default router;
