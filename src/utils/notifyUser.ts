import Notification from "../models/Notification.js";
import { shouldNotify } from "../services/notificationPreferenceService.js";
import type { NotificationEvent } from "./types.js";

// Call this alongside sendPushToUser/sendExpoPushToUser, not instead of it —
// push is delivery to a device that may or may not be listening right now;
// this is the durable record a manager can come back to later. Gated by the
// same per-user "inApp" preference the other two channels already respect.
export async function notifyUser(params: {
  userId: string;
  companyId: unknown;
  event: NotificationEvent;
  title: string;
  body: string;
  link?: string;
}): Promise<void> {
  const canInApp = await shouldNotify(params.userId, params.event, "inApp");
  if (!canInApp) return;

  await Notification.create({
    user: params.userId,
    company: params.companyId as string,
    type: params.event,
    title: params.title,
    body: params.body,
    link: params.link ?? null,
  });
}
