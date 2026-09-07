import { Router } from "express";
import {
    cancelInvoiceHandler,
    createInvoice,
    createInvoiceDraft,
    deleteInvoice,
    getAllInvoices,
    getClientBillingInfoHandler,
    getEligibleWorkHandler,
    getInvoice,
    markInvoicePaid,
    sendInvoiceHandler,
    updateInvoice,
    updateInvoiceStatusHandler,
} from "../controllers/invoiceController.js";
import { authorizePermissions } from "../middleware/authMiddleware.js";

// authenticateUser is applied at the mount point in server.ts, same as
// every other route group in this app — not duplicated here.
const router = Router();

// Registered before the generic "/:id" GET below — otherwise Express would
// match "/eligible-work" against ":id" and call getInvoice instead.
router.get("/eligible-work", authorizePermissions("admin", "manager"), getEligibleWorkHandler);
router.get("/billing-info", authorizePermissions("admin", "manager"), getClientBillingInfoHandler);
router.post("/draft", authorizePermissions("admin", "manager"), createInvoiceDraft);

router
    .route("/")
    .get(authorizePermissions("admin", "manager"), getAllInvoices)
    .post(authorizePermissions("admin", "manager"), createInvoice);

router
    .route("/:id")
    .get(authorizePermissions("admin", "manager"), getInvoice)
    .patch(authorizePermissions("admin", "manager"), updateInvoice)
    .delete(authorizePermissions("admin", "manager"), deleteInvoice);

router.patch("/:id/status", authorizePermissions("admin", "manager"), updateInvoiceStatusHandler);
router.post("/:id/send", authorizePermissions("admin", "manager"), sendInvoiceHandler);
router.patch("/:id/mark-paid", authorizePermissions("admin", "manager"), markInvoicePaid);
router.patch("/:id/cancel", authorizePermissions("admin", "manager"), cancelInvoiceHandler);

export default router;
