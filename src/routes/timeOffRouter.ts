// @ts-ignore
import express from "express";
import {
    cancelTimeOffRequest,
    getCompanyTimeOffRequests,
    getMyTimeOffRequests,
    requestTimeOff,
    reviewTimeOffRequest,
} from "../controllers/timeOffController.js";
import { authorizePermissions } from "../middleware/authMiddleware.js";

const router = express.Router();

router.route("/me")
    .get(authorizePermissions("worker"), getMyTimeOffRequests)
    .post(authorizePermissions("worker"), requestTimeOff);

router.route("/me/:id/cancel")
    .patch(authorizePermissions("worker"), cancelTimeOffRequest);

router.route("/")
    .get(authorizePermissions("admin", "manager"), getCompanyTimeOffRequests);

router.route("/:id/review")
    .patch(authorizePermissions("admin", "manager"), reviewTimeOffRequest);

export default router;
