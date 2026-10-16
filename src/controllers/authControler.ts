import { OAuth2Client } from "google-auth-library";
import { StatusCodes } from "http-status-codes";
import mongoose from "mongoose";
import {
  BadRequestError,
  NotFoundError,
  UnauthenticatedError,
  UnauthorizedError,
} from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import Company from "../models/company.js";
import User from "../models/userModel.js";
import { setCookies } from "../utils/cookieUtils.js";
import { comparePassword, hashPassword } from "../utils/passwordUtils.js";
import {
  createAccessToken,
  createEmailVerificationToken,
  createPasswordResetToken,
  createRefreshToken,
  hashEmailVerificationToken,
  hashPasswordResetToken,
  hashRefreshToken,
  sanitizeUser,
} from "../utils/tokenUtils.js";
import { sendPasswordResetEmail, sendVerificationEmail } from "../utils/mailTemplates.js";
import NotificationPreferenceModel from "../models/NotificationPreferenceModel.js";

const ACCESS_TOKEN_COOKIE_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_COOKIE_MS = (Number(process.env.REFRESH_TOKEN_EXPIRES_IN_DAYS) || 30) * 24 * 60 * 60 * 1000;

// Session cap — bounds how many devices/sessions one user can have live at
// once, enforced via $slice below (MongoDB's own atomic "keep last N"
// array trim, not a separate cleanup step). Covers a phone plus a few
// browsers/tabs with headroom; easy to adjust.
const MAX_SESSIONS_PER_USER = 10;

// Issues an access + refresh token pair for `user`, persists the refresh
// token's hash as one entry in the user's `sessions` array (so multiple
// devices can be logged in independently — see userModel.ts), and sets
// both as httpOnly cookies on `res`.
//
// `replaceSessionHash` is set only when rotating an EXISTING session (from
// refresh() below) — it removes that one entry before pushing the new one,
// so a refresh replaces its own slot instead of accumulating a new array
// entry every time. Every fresh-login call site omits it, which is
// correct: a new login should ADD a session, not replace one.
export const issueTokens = async (
  user: mongoose.Document & { _id: any; role: string; company?: any; client?: any },
  res: import("express").Response,
  replaceSessionHash?: string
) => {
  const accessToken = createAccessToken({
    user_id: user._id.toString(),
    role: user.role,
    company_id: user.company as unknown as string,
    // Only role:"client" users ever have this set (enforced by
    // userModel.ts's pre("validate") hook) — every /portal/* route derives
    // its scope from this, never from anything client-supplied.
    ...(user.role === "client" && user.client ? { client_id: user.client.toString() } : {}),
  });
  const { token: refreshToken, hash, expiresAt } = createRefreshToken();

  // Two separate updateOne calls — MongoDB doesn't allow $pull and $push
  // on the same array path within a single update document.
  if (replaceSessionHash) {
    await User.updateOne(
      { _id: user._id },
      { $pull: { sessions: { tokenHash: replaceSessionHash } } }
    );
  }
  await User.updateOne(
    { _id: user._id },
    {
      $push: {
        sessions: {
          $each: [{ tokenHash: hash, expiresAt, createdAt: new Date() }],
          $slice: -MAX_SESSIONS_PER_USER,
        },
      },
    }
  );

  res.cookie("refreshToken", refreshToken, setCookies(REFRESH_TOKEN_COOKIE_MS));
  res.cookie("token", accessToken, setCookies(ACCESS_TOKEN_COOKIE_MS));
  return {
    accessToken,
    refreshToken,
  }
};



export const loginWithGoogle: MiddlewareFn = async (req, res) => {

  const { code } = req.body;

  if (!code) {
    throw new BadRequestError("Authorization code is required.");
  }

  const client = new OAuth2Client({
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  });

  const { tokens } = await client.getToken({
    code,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI!, // postmessage
  });

  if (!tokens.id_token) {
    throw new UnauthenticatedError("Failed to obtain Google ID token.");
  }

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: process.env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();

  if (!payload?.email) {
    throw new UnauthenticatedError("Google account does not have an email address.");
  }

  const user = await User.findOne({
    email: payload.email,
  });

  if (!user) {
    throw new UnauthenticatedError(
      "No account exists with this Google email address."
    );
  }
  await issueTokens(user, res);

  res.status(StatusCodes.OK).json({
    success: true,
    msg: "Logged in successfully.",
    user,
  });
};

export const login: MiddlewareFn = async (req, res) => {

  const {
    email,
    password,
  }: {
    email: string;
    password: string;
  } = req.body;
  const user = await User.findOne({ email: email }).select("+password");
  const isValidUser = user && (await comparePassword(password, user.password));
  if (!isValidUser) throw new UnauthenticatedError("invalid credentials");

  // This is the staff app — a client-portal account authenticates through
  // /client-auth/login instead (clientAuthController.ts). Same reasoning
  // as mobileLogin's worker-only gate just below, opposite direction.
  if (user.role === "client") {
    throw new UnauthorizedError("Please sign in through the client portal.");
  }

  await issueTokens(user, res);

  res.status(StatusCodes.OK).json({ msg: "user logged in", user: sanitizeUser(user) });
};

export const mobileLogin: MiddlewareFn = async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email }).select("+password");

  const isValidUser =
    user && (await comparePassword(password, user.password));

  if (!isValidUser) {
    throw new UnauthenticatedError("invalid credentials");
  }

  // The mobile app is worker-only — admins/managers use the web dashboard.
  // Credentials are otherwise valid, so this is an authorization failure
  // (403), not an authentication one.
  if (user.role !== "worker") {
    throw new UnauthorizedError("This app is for workers only. Please use the web dashboard to sign in.");
  }

  const { accessToken, refreshToken } = await issueTokens(user, res);

  res.status(StatusCodes.OK).json({
    msg: "user logged in",
    user: sanitizeUser(user),
    accessToken,
    refreshToken,
  });
};
export const register: MiddlewareFn = async (req, res) => {
  const {
    password,
    email,
    name,
    companyName,
    businessType,
    companySize,
    website,
    phone,
    country,
  } = req.body;

  const fullname = name.trim();

  // 1. Check if user exists
  const isUserAlreadyExist = await User.findOne({ email });
  if (isUserAlreadyExist) {
    throw new BadRequestError(`User already exists with email ${email}`);
  }

  const hashedPassword = await hashPassword(password);

  // 2. Create the company's Owner. Signup always founds a brand-new
  // company, so whoever's registering here is the owner, not just an
  // admin — Company.owner (set below) is the authoritative record of this,
  // but the user's own role mirrors it for authorizePermissions checks.
  const user = await User.create({
    fullname,
    email,
    password: hashedPassword,
    phone: phone || "0000-0000-0000",
    role: "owner",
  });

  // 3. Create Company with manual rollback on failure
  let company;
  try {
    // Every new company starts on a 30-day, no-card Professional trial —
    // see Company.trialEndsAt's own comment. Reverted automatically by
    // utils/expireTrials.ts's daily cron once trialEndsAt passes, unless
    // the company has since started a real paid Stripe subscription.
    const trialEndsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    company = await Company.create({
      name: companyName,
      businessType,
      size: companySize,
      website: website || "",
      country: country || "",
      phone: phone || "",
      owner: user._id,
      isActive: true,
      plan: "professional",
      trialEndsAt,
      trialUsedAt: new Date(),
    });
  } catch (error) {
    // If company creation fails, delete the created user to prevent orphaned data
    await User.findByIdAndDelete(user._id);
    throw error;
  }

  // 4. Attach company ID back to User + a fresh email-verification token
  const { token: verificationToken, hash, expiresAt } = createEmailVerificationToken();
  user.company = company._id;
  user.emailVerificationToken = hash;
  user.emailVerificationExpiresAt = expiresAt;
  await user.save();
  await NotificationPreferenceModel.create({
    company: user.company,
    user: user._id
  })
  // 5. Issue Token & Cookie
  await issueTokens(user, res);

  // Fire-and-forget — verification shouldn't block signup from completing.
  sendVerificationEmail({ email: user.email, fullname: user.fullname, verificationToken }).catch(err =>
    console.error(`Failed to send verification email to ${user.email}:`, err)
  );

  res.status(StatusCodes.CREATED).json({
    msg: "User and company created successfully",
    user: {
      ...sanitizeUser(user),
      company: company._id,
    },
  });
};
// Exchanges a still-valid refresh token for a new access token (rotating
// the refresh token too, so a stolen-and-replayed old refresh token stops
// working the moment the legitimate client refreshes). Web sends it as an
// httpOnly cookie; mobile has no cookie jar, so it sends the one it stored
// from login/the previous refresh in the body instead — falls back to that
// when no cookie is present.
export const refresh: MiddlewareFn = async (req, res) => {
  const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;
  if (!refreshToken) throw new UnauthenticatedError("authentication invalid");

  const hash = hashRefreshToken(refreshToken);

  // Matches either the current sessions[] shape or the legacy single-slot
  // refreshToken field — a session issued before the multi-session deploy
  // still has its hash sitting in the old field, not yet in sessions[].
  // Matching both here means that deploy doesn't log anyone out; the first
  // successful refresh below migrates it into sessions[] and clears the
  // old field. Safe to drop the legacy half of this query once
  // REFRESH_TOKEN_EXPIRES_IN_DAYS has fully elapsed since that deploy.
  const user = await User.findOne({
    $or: [{ refreshToken: hash }, { "sessions.tokenHash": hash }],
  }).select("+refreshToken +refreshTokenExpiresAt +sessions");

  const matchedSession = user?.sessions?.find((s) => s.tokenHash === hash);
  const matchedLegacy = user && user.refreshToken === hash;
  const matchedExpiresAt = matchedSession?.expiresAt ?? (matchedLegacy ? user!.refreshTokenExpiresAt : undefined);

  // isActive is checked here (not just at login) because authenticateUser
  // is purely stateless JWT verification with no DB lookup — disabling a
  // user doesn't invalidate an already-issued access token, only blocks
  // it from being renewed past its ~15-minute lifetime. This is where
  // "disabled" actually takes effect, for staff and portal users alike.
  if (!user || !matchedExpiresAt || matchedExpiresAt < new Date() || !user.isActive) {
    res.cookie("token", "logout", setCookies());
    res.cookie("refreshToken", "logout", setCookies());
    throw new UnauthenticatedError("authentication invalid");
  }

  const { accessToken, refreshToken: newRefreshToken } = await issueTokens(user, res, hash);

  // The matched session came from the deprecated single-slot field — this
  // is the migration: clear it now that the same session lives in
  // sessions[] going forward (issueTokens already pushed it there).
  if (matchedLegacy) {
    await User.updateOne({ _id: user._id }, { $unset: { refreshToken: "", refreshTokenExpiresAt: "" } });
  }

  // Cookies are set above for web; the body carries the same pair for
  // mobile, which has nowhere else to read a rotated token from.
  res.status(StatusCodes.OK).json({
    success: true,
    msg: "token refreshed",
    accessToken,
    refreshToken: newRefreshToken,
  });
};

// Public — the link in the verification email is opened outside any
// authenticated session, so this can't rely on req.user.
export const verifyEmail: MiddlewareFn = async (req, res) => {
  const token = (req.body?.token ?? req.query?.token) as string | undefined;
  if (!token) throw new BadRequestError("Verification token is required.");

  const hash = hashEmailVerificationToken(token);
  const user = await User.findOne({ emailVerificationToken: hash }).select(
    "+emailVerificationToken +emailVerificationExpiresAt"
  );

  if (!user || !user.emailVerificationExpiresAt || user.emailVerificationExpiresAt < new Date()) {
    throw new BadRequestError("This verification link is invalid or has expired.");
  }

  user.isVerified = true;
  user.emailVerificationToken = undefined;
  user.emailVerificationExpiresAt = undefined;
  await user.save();

  res.status(StatusCodes.OK).json({ success: true, msg: "Email verified successfully." });
};

// Authenticated — lets an already-logged-in-but-unverified user request a
// fresh link once the first one expires or gets lost.
export const resendVerificationEmail: MiddlewareFn = async (req, res) => {
  const user = await User.findById(req.user.user_id);
  if (!user) throw new NotFoundError("User not found.");

  if (user.isVerified) {
    res.status(StatusCodes.OK).json({ success: true, msg: "Email is already verified." });
    return;
  }

  const { token: verificationToken, hash, expiresAt } = createEmailVerificationToken();
  user.emailVerificationToken = hash;
  user.emailVerificationExpiresAt = expiresAt;
  await user.save();

  sendVerificationEmail({ email: user.email, fullname: user.fullname, verificationToken }).catch(err =>
    console.error(`Failed to send verification email to ${user.email}:`, err)
  );

  res.status(StatusCodes.OK).json({ success: true, msg: "Verification email sent." });
};

// Public — a forgotten password means the user can't log in, so this can't
// require authentication. Always returns the same message whether or not the
// email is registered, so it can't be used to enumerate accounts.
export const forgotPassword: MiddlewareFn = async (req, res) => {
  const { email } = req.body;
  if (!email) throw new BadRequestError("Email is required.");

  const user = await User.findOne({ email: email.toLowerCase() });

  if (user) {
    const { token: resetToken, hash, expiresAt } = createPasswordResetToken();
    user.passwordResetToken = hash;
    user.passwordResetExpiresAt = expiresAt;
    await user.save();

    sendPasswordResetEmail({ email: user.email, fullname: user.fullname, resetToken, isPortalAccount: user.role === "client" }).catch(err =>
      console.error(`Failed to send password reset email to ${user.email}:`, err)
    );
  }

  res.status(StatusCodes.OK).json({
    success: true,
    msg: "If an account exists with that email, a reset link has been sent.",
  });
};

export const resetPassword: MiddlewareFn = async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) throw new BadRequestError("Token and new password are required.");
  if (password.length < 8) throw new BadRequestError("Password must be at least 8 characters long.");

  const hash = hashPasswordResetToken(token);
  const user = await User.findOne({ passwordResetToken: hash }).select(
    "+passwordResetToken +passwordResetExpiresAt"
  );

  if (!user || !user.passwordResetExpiresAt || user.passwordResetExpiresAt < new Date()) {
    throw new BadRequestError("This reset link is invalid or has expired.");
  }

  user.password = await hashPassword(password);
  user.passwordResetToken = undefined;
  user.passwordResetExpiresAt = undefined;
  // A password reset invalidates EVERY session — force re-login on every
  // device rather than leaving a stolen account's refresh tokens valid.
  // Unlike logout (below), which only ends one session, this intentionally
  // clears the whole sessions array.
  user.sessions = [] as any;
  user.refreshToken = undefined;
  user.refreshTokenExpiresAt = undefined;
  await user.save();

  res.cookie("token", "logout", setCookies());
  res.cookie("refreshToken", "logout", setCookies());

  res.status(StatusCodes.OK).json({ success: true, msg: "Password reset successfully. Please log in." });
};

export const logout: MiddlewareFn = async (req, res) => {
  // Web sends it as an httpOnly cookie; mobile has no cookie jar, so it
  // sends the one it stored in the body instead — same fallback refresh()
  // already uses. (Previously this only checked the cookie, so mobile
  // logout silently did nothing server-side.)
  const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;
  if (refreshToken) {
    const hash = hashRefreshToken(refreshToken);
    // Only the ONE session being logged out of — not every device, unlike
    // resetPassword above. $pull removes just the matching sessions[]
    // entry; $unset also clears the legacy field in case this session was
    // issued before the multi-session migration and never got the chance
    // to refresh (and therefore migrate) first.
    await User.updateOne(
      { $or: [{ refreshToken: hash }, { "sessions.tokenHash": hash }] },
      {
        $pull: { sessions: { tokenHash: hash } },
        $unset: { refreshToken: "", refreshTokenExpiresAt: "" },
      }
    );
  }

  res.cookie("token", "logout", setCookies());
  res.cookie("refreshToken", "logout", setCookies());
  res.status(StatusCodes.OK).json({ msg: "user logged out!" });
};
