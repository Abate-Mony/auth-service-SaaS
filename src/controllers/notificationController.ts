import { StatusCodes } from "http-status-codes";
import { NotFoundError } from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import Notification from "../models/Notification.js";

// The manager/admin's personal notification inbox — every entry here was
// already delivered as a push (or would have been, had they subscribed);
// this is just the durable record of it. See utils/notifyUser.ts for where
// these get written.
export const getMyNotifications: MiddlewareFn = async (req, res) => {
  const userId = req.user.user_id;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));

  const [notifications, total, unreadCount] = await Promise.all([
    Notification.find({ user: userId })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Notification.countDocuments({ user: userId }),
    // Unread across everything, not just this page — a badge that reset to
    // "0 unread" once you'd paged past the first 20 would be worse than
    // useless, so this is a real count, not derived from `notifications`.
    Notification.countDocuments({ user: userId, isRead: false }),
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

  const notification = await Notification.findOneAndUpdate(
    { _id: id, user: userId },
    { isRead: true },
    { new: true }
  );
  if (!notification) throw new NotFoundError("Notification not found.");

  res.status(StatusCodes.OK).json({ success: true, notification });
};

export const markAllNotificationsRead: MiddlewareFn = async (req, res) => {
  const userId = req.user.user_id;

  await Notification.updateMany({ user: userId, isRead: false }, { isRead: true });

  res.status(StatusCodes.OK).json({ success: true });
};
