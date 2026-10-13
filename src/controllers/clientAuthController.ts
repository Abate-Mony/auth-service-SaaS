import { StatusCodes } from "http-status-codes";
import { UnauthenticatedError, UnauthorizedError } from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import User from "../models/userModel.js";
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
