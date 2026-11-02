import User from "../models/userModel.js";
import Notification from "../models/Notification.js";
import { canClient, type ClientRole } from "./clientPermissions.js";
import { sendExpoPushToUser } from "./expoPush.js";

type ClientBookingNotification = {
    companyId: unknown;
    clientId: unknown;
    requesterId?: unknown;
    event: string;
    title: string;
    body: string;
    link: string;
};

// A delivery failure must never undo the booking action. Persist the inbox
// attempt before push so opening a received alert can find its record.
// Client booking updates follow notifyClient's mandatory delivery policy;
// staff notification preferences do not apply to these client records.
export async function notifyClientBooking(params: ClientBookingNotification): Promise<void> {
    if (!params.companyId || !params.clientId) return;
    try {
        const recipients = await User.find({
            company: params.companyId,
            client: params.clientId,
            role: "client",
            isActive: true,
            ...(params.requesterId ? { _id: params.requesterId } : {}),
        }).select("_id clientRole").lean();
        await Promise.all(recipients
            .filter(user => canClient(user.clientRole as ClientRole, "booking:read"))
            .map(async user => {
                const userId = user._id.toString();
                try {
                        await Notification.create({
                            user: userId,
                            company: params.companyId as string,
                            type: params.event,
                            title: params.title,
                            body: params.body,
                            link: params.link,
                        });
                } catch (error) {
                    console.error(`Failed to save client booking notification for ${userId}:`, error);
                }
                try {
                        await sendExpoPushToUser(userId, {
                            title: params.title,
                            body: params.body,
                            url: params.link,
                            tag: params.event,
                        });
                } catch (error) {
                    console.error(`Failed to push client booking notification for ${userId}:`, error);
                }
            }));
    } catch (error) {
        console.error("Failed to select client booking notification recipients:", error);
    }
}
