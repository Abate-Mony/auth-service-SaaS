import { Router } from "express";
import { getActiveAnnouncements } from "../controllers/announcementController.js";

const router = Router();

router.get("/active", getActiveAnnouncements);

export default router;
