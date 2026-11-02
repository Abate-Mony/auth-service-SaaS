import { StatusCodes } from "http-status-codes";
import { NotFoundError } from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import Notification from "../models/Notification.js";
import mongoose from "mongoose";

const positiveInteger = (value: unknown, fallback: number, maximum: number): number => {
  const parsed = typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
};

// The manager/admin's personal notification inbox — every entry here was
// already delivered as a push (or would have been, had they subscribed);
// this is just the durable record of it. See utils/notifyUser.ts for where
// these get written.
export const getMyNotifications: MiddlewareFn = async (req, res) => {
  const userId = req.user.user_id;
  const scope = { user: userId, company: req.user.company_id };
  const page = positiveInteger(req.query.page, 1, 1_000_000);
  const limit = positiveInteger(req.query.limit, 20, 50);

  const [notifications, total, unreadCount] = await Promise.all([
    Notification.find(scope)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Notification.countDocuments(scope),
    // Unread across everything, not just this page — a badge that reset to
    // "0 unread" once you'd paged past the first 20 would be worse than
    // useless, so this is a real count, not derived from `notifications`.
    Notification.countDocuments({ ...scope, isRead: false }),
  ]);

  res.status(StatusCodes.OK).json({
    success: true,
    notifications,
    page,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    total,
    unreadCount,
  });
};

export const markNotificationRead: MiddlewareFn = async (req, res) => {
  const userId = req.user.user_id;
  const { id } = req.params;
  if (typeof id !== "string" || !mongoose.isValidObjectId(id)) throw new NotFoundError("Notification not found.");

  const notification = await Notification.findOneAndUpdate(
    { _id: id, user: userId, company: req.user.company_id },
    { isRead: true },
    { new: true }
  );
  if (!notification) throw new NotFoundError("Notification not found.");

  res.status(StatusCodes.OK).json({ success: true, notification });
};

export const markAllNotificationsRead: MiddlewareFn = async (req, res) => {
  const userId = req.user.user_id;

  await Notification.updateMany({ user: userId, company: req.user.company_id, isRead: false }, { isRead: true });

  res.status(StatusCodes.OK).json({ success: true });
};
