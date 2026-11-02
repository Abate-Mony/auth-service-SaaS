import { Expo, ExpoPushMessage } from "expo-server-sdk";
import User from "../models/userModel.js";
import type { PushPayload } from "./webPush.js";

const expo = new Expo();

// Sends to every Expo push token the worker's mobile app has registered; an
// invalid/unregistered token (DeviceNotRegistered) is pruned so future sends
// don't keep retrying it. Mirrors sendPushToUser (webPush.ts) but for the
// React Native app instead of browser Web Push subscriptions.
export async function sendExpoPushToUser(userId: string, payload: PushPayload): Promise<void> {
    const user = await User.findById(userId).select("expoPushTokens clientPushTokens");
    const tokens = [...new Set([
        ...(user?.expoPushTokens ?? []),
        ...(user?.clientPushTokens ?? []).map(registration => registration.token),
    ])].filter(t => Expo.isExpoPushToken(t));
    if (!tokens.length) return;

    const messages: ExpoPushMessage[] = tokens.map(to => ({
        to,
        title: payload.title,
        body: payload.body,
        data: { url: payload.url, tag: payload.tag, userId },
        sound: "default",
        priority: "high",
        // Must match the channel the app creates on the device
        // (setNotificationChannelAsync("default", ...) in pushNotifications.ts) —
        // an unmatched id falls back to Android's default-importance channel,
        // which can arrive silently instead of as a heads-up banner.
        channelId: "default",
    }));

    const deadTokens: string[] = [];
    for (const chunk of expo.chunkPushNotifications(messages)) {
        try {
            const tickets = await expo.sendPushNotificationsAsync(chunk);
            tickets.forEach((ticket, index) => {
                const token = chunk[index].to;
                if (typeof token === "string" && ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered") {
                    deadTokens.push(token);
                }
            });
        } catch (err) {
            console.error(`Failed to send Expo push notification(s) to user ${userId}:`, err);
        }
    }

    if (deadTokens.length) {
        await User.updateOne({ _id: userId }, {
            $pull: {
                expoPushTokens: { $in: deadTokens },
                clientPushTokens: { token: { $in: deadTokens } },
            },
        });
    }
}
