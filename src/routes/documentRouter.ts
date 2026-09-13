import { Router } from "express";

import {
  uploadMyDocument,
  getMyDocuments,
  deleteMyDocument,
  getWorkerDocuments,
} from "../controllers/documentController.js";
import { authorizePermissions } from "../middleware/authMiddleware.js";
import upload from "../middleware/multerMiddleware.js";

const router = Router();

router.route("/me")
  .get(authorizePermissions("worker"), getMyDocuments)
  .post(authorizePermissions("worker"), upload.single("document"), uploadMyDocument);

router.route("/me/:documentId").delete(authorizePermissions("worker"), deleteMyDocument);

router.route("/worker/:workerId").get(authorizePermissions("admin", "manager"), getWorkerDocuments);

export default router;
