import { StatusCodes } from "http-status-codes";
import { UnauthenticatedError, UnauthorizedError } from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import User from "../models/userModel.js";
import Client from "../models/clientModel.js";
import Company from "../models/company.js";
import { comparePassword } from "../utils/passwordUtils.js";
import { sanitizeUser } from "../utils/tokenUtils.js";
import { issueTokens } from "./authControler.js";

// POST /client-auth/login — the only entry point for role:"client"
// accounts. Mirrors mobileLogin's worker-only gate (authControler.ts),
// just checking the opposite role. Checks isActive explicitly rather than
// relying on role alone, since isActive is how a disabled portal user is
// actually meant to be locked out at login time.
export const clientLogin: MiddlewareFn = async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findOne({ email }).select("+password");

    const isValidUser = user && (await comparePassword(password, user.password));
    if (!isValidUser) {
        throw new UnauthenticatedError("invalid credentials");
    }

    if (user.role !== "client") {
        throw new UnauthorizedError("This sign-in is for the client portal only.");
    }
    if (!user.isActive) {
        throw new UnauthorizedError("This account has been disabled.");
    }

    await issueTokens(user, res);

    res.status(StatusCodes.OK).json({ msg: "user logged in", user: sanitizeUser(user) });
};

// POST /client-auth/mobile-login — the client mobile app's equivalent of
// workerRouter.ts's /auth/mobile/login. clientLogin above only sets
// httpOnly cookies (built for the web portal); a mobile app has nowhere
// to read a token from except the response body, same reasoning as the
// worker app's mobileLogin. Also returns client/company up front (what
// getPortalMe otherwise provides) so the app doesn't need a second round
// trip immediately after login.
export const clientMobileLogin: MiddlewareFn = async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findOne({ email }).select("+password");

    const isValidUser = user && (await comparePassword(password, user.password));
    if (!isValidUser) {
        throw new UnauthenticatedError("invalid credentials");
    }

    if (user.role !== "client") {
        throw new UnauthorizedError("This app is for clients only.");
    }
    if (!user.isActive) {
        throw new UnauthorizedError("This account has been disabled.");
    }

    const { accessToken, refreshToken } = await issueTokens(user, res);

    const [client, company] = await Promise.all([
        Client.findOne({ _id: user.client, company: user.company, lifecycle: "client", status: "active", isDeleted: false }).select("name"),
        Company.findById(user.company).select("name logo"),
    ]);
    if (!client) throw new UnauthorizedError("This client account is no longer active.");

    res.status(StatusCodes.OK).json({
        msg: "user logged in",
        user: sanitizeUser(user),
        client: { _id: client._id, name: client.name },
        company: company ? { name: company.name, logo: company.logo?.url ?? null } : null,
        accessToken,
        refreshToken,
    });
};
