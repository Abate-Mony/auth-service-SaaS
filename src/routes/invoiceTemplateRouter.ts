import { Router } from "express";
import {
    createInvoiceTemplate,
    deleteInvoiceTemplate,
    getInvoiceTemplates,
    previewInvoiceTemplate,
    updateInvoiceTemplate,
} from "../controllers/invoiceTemplateController.js";
import { authorizePermissions } from "../middleware/authMiddleware.js";

const router = Router();

// admin/manager only — same gate as the invoice routes themselves.
router.get("/", authorizePermissions("admin", "manager"), getInvoiceTemplates);
router.post("/", authorizePermissions("admin", "manager"), createInvoiceTemplate);
router.post("/preview", authorizePermissions("admin", "manager"), previewInvoiceTemplate);
router.patch("/:id", authorizePermissions("admin", "manager"), updateInvoiceTemplate);
router.delete("/:id", authorizePermissions("admin", "manager"), deleteInvoiceTemplate);

export default router;
