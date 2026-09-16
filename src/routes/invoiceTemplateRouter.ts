import { Router } from "express";
import { getInvoiceTemplates } from "../controllers/invoiceTemplateController.js";
import { authorizePermissions } from "../middleware/authMiddleware.js";

const router = Router();

// admin/manager only — same gate as the invoice routes themselves.
router.get("/", authorizePermissions("admin", "manager"), getInvoiceTemplates);

export default router;
