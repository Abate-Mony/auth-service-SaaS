import webpush from "web-push";
import User from "../models/userModel.js";

// Configured lazily on first send, not at import time — ES module imports
// all evaluate before server.ts's own top-level dotenv.config() call runs
// (regardless of where that call appears in the file), so reading
// process.env here at module load would always see it as unset.
let vapidConfigured = false;
function ensureVapidConfigured() {
    if (vapidConfigured) return;
    webpush.setVapidDetails(
        process.env.VAPID_SUBJECT!,
        process.env.VAPID_PUBLIC_KEY!,
        process.env.VAPID_PRIVATE_KEY!
    );
    vapidConfigured = true;
}

export interface PushPayload {
    title: string;
    body: string;
    url?: string;
    tag?: string;
}

// Sends to every device the worker has subscribed on; a dead subscription
// (410 — the browser revoked it) is pruned so future sends don't keep
// retrying it.
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
    ensureVapidConfigured();
    const user = await User.findById(userId).select("pushSubscriptions");
    if (!user?.pushSubscriptions?.length) return;

    await Promise.all(
        user.pushSubscriptions
            .filter(sub => sub.keys?.p256dh && sub.keys?.auth)
            .map(sub =>
                webpush
                    .sendNotification(
                        { endpoint: sub.endpoint, keys: { p256dh: sub.keys!.p256dh, auth: sub.keys!.auth } },
                        JSON.stringify(payload)
                    )
                    .catch(err => {
                        if (err instanceof webpush.WebPushError && err.statusCode === 410) {
                            User.updateOne(
                                { _id: userId },
                                { $pull: { pushSubscriptions: { endpoint: sub.endpoint } } }
                            ).exec();
                            return;
                        }
                        console.error(`Failed to send push notification to user ${userId}:`, err);
                    })
            )
    );
}
