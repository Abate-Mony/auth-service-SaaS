import { Expo } from "expo-server-sdk";
import { StatusCodes } from "http-status-codes";
import { BadRequestError, UnauthorizedError } from "../errors/customErrors.js";
import type { MiddlewareFn } from "../interfaces/expresstype.js";
import User from "../models/userModel.js";

export type ClientPushRegistration = { token: string; registrationId: string };

export function isClientPushRegistration(value: unknown): value is ClientPushRegistration {
    if (!value || typeof value !== "object") return false;
    const { token, registrationId } = value as Partial<ClientPushRegistration>;
    return typeof token === "string" && Expo.isExpoPushToken(token) &&
        typeof registrationId === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(registrationId);
}

async function activeClientScope(req: Parameters<MiddlewareFn>[0]) {
    const scope = {
        _id: req.user.user_id,
        company: req.user.company_id,
        client: req.user.client_id,
        role: "client" as const,
        isActive: true,
    };
    const user = await User.findOne(scope).select("_id");
    if (!user) throw new UnauthorizedError("Client portal access required.");
    return scope;
}

export const saveClientPushToken: MiddlewareFn = async (req, res) => {
    if (!isClientPushRegistration(req.body)) throw new BadRequestError("A valid Expo push registration is required.");
    const scope = await activeClientScope(req);
    const { token, registrationId } = req.body as ClientPushRegistration;
    // The mobile queue serializes registration, cleanup and the next login.
    await User.updateMany(
        { $or: [{ "clientPushTokens.token": token }, { expoPushTokens: token }] },
        { $pull: { clientPushTokens: { token }, expoPushTokens: token } }
    );
    await User.updateOne(scope, { $addToSet: { clientPushTokens: { token, registrationId } } });
    res.status(StatusCodes.OK).json({ success: true });
};

export const removeClientPushToken: MiddlewareFn = async (req, res) => {
    if (!isClientPushRegistration(req.body)) throw new BadRequestError("A valid Expo push registration is required.");
    const scope = await activeClientScope(req);
    const { token, registrationId } = req.body as ClientPushRegistration;
    // Exact generation matching also protects a newer login to the SAME user.
    await User.updateOne(scope, { $pull: { clientPushTokens: { token, registrationId } } });
    res.status(StatusCodes.OK).json({ success: true });
};
