import Notification from "../models/Notification.js";
import User from "../models/userModel.js";
import { sendExpoPushToUser } from "./expoPush.js";
import { canClient, type ClientAction, type ClientRole } from "./clientPermissions.js";

// Client-portal equivalent of notifyUser.ts — writes the durable in-app
// record and fires the push in one call. Unlike the staff version, this is
// never gated by a per-user channel preference: there's no client-facing
// notification-preferences screen (yet), so every client notification here
// is unconditional. `link` is a client-portal-relative path (e.g.
// "/bookings/<id>") — see client-mobile's resolveNotificationDestination,
// which is the only thing that ever interprets it.
async function notifyClientUser(params: {
    userId: string;
    companyId: unknown;
    type: string;
    title: string;
    body: string;
    link?: string;
}): Promise<void> {
    await Notification.create({
        user: params.userId,
        company: params.companyId as string,
        type: params.type,
        title: params.title,
        body: params.body,
        link: params.link ?? null,
    });

    await sendExpoPushToUser(params.userId, {
        title: params.title,
        body: params.body,
        url: params.link,
        tag: params.type,
    });
}

// Notifies one specific client-portal user — use this when the event
// already has a specific requester (e.g. their own booking/reschedule
// request being approved or declined).
export async function notifyClient(params: {
    userId: string;
    companyId: unknown;
    type: string;
    title: string;
    body: string;
    link?: string;
}): Promise<void> {
    await notifyClientUser(params).catch(err =>
        console.error(`Failed to notify client user ${params.userId} (${params.type}):`, err)
    );
}

// Notifies every active client-portal user on a Client account who has the
// given permission — use this for account-level events (a quote/invoice
// being sent) that aren't tied to any one requester, since any of that
// account's owner/manager/billing users may reasonably need to act on it.
export async function notifyClientAccount(params: {
    clientId: unknown;
    companyId: unknown;
    permission: ClientAction;
    type: string;
    title: string;
    body: string;
    link?: string;
}): Promise<void> {
    try {
        const users = await User.find({
            client: params.clientId,
            role: "client",
            isActive: true,
        }).select("_id clientRole");

        const recipients = users.filter(u => u.clientRole && canClient(u.clientRole as ClientRole, params.permission));

        await Promise.all(recipients.map(u => notifyClientUser({
            userId: u._id.toString(),
            companyId: params.companyId,
            type: params.type,
            title: params.title,
            body: params.body,
            link: params.link,
        })));
    } catch (err) {
        console.error(`Failed to notify client account ${params.clientId} (${params.type}):`, err);
    }
}
