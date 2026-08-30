import crypto from "crypto";
import jwt, { Secret, SignOptions } from "jsonwebtoken";
import mongoose from "mongoose";
// import { IUser } from "../interfaces/models/user.js";

interface Payload {
  user_id: string | mongoose.Types.ObjectId;
  role: string;
  company_id: string | mongoose.Types.ObjectId
}

// Short-lived: only proves identity for API calls. Kept separate from the
// refresh token so a stolen access token expires quickly on its own.
export const createAccessToken = (payload: Payload): string => {
  const token = jwt.sign(payload, process.env.JWT_SECRET as Secret, {
    expiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || "15m",
  } as SignOptions);
  return token;
};

export const verifyAccessToken = (token: string): Payload => {
  const decoded = jwt.verify(token, process.env.JWT_SECRET as Secret);
  return decoded as Payload;
};

const REFRESH_TOKEN_EXPIRES_IN_DAYS = Number(process.env.REFRESH_TOKEN_EXPIRES_IN_DAYS) || 30;

// Opaque random token (not a JWT) — the raw value goes to the client in a
// cookie, only its SHA-256 hash is stored on the user document. This lets a
// refresh token be revoked/rotated server-side, which a stateless JWT can't.
export const createRefreshToken = (): { token: string; hash: string; expiresAt: Date } => {
  const token = crypto.randomBytes(40).toString("hex");
  const hash = hashRefreshToken(token);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000);
  return { token, hash, expiresAt };
};

export const hashRefreshToken = (token: string): string =>
  crypto.createHash("sha256").update(token).digest("hex");

const EMAIL_VERIFICATION_EXPIRES_HOURS = 24;

// Same opaque-token-plus-hash shape as the refresh token, for the same
// reason: only the hash lives in the database, so a leaked DB row can't be
// replayed as a working verification link.
export const createEmailVerificationToken = (): { token: string; hash: string; expiresAt: Date } => {
  const token = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_EXPIRES_HOURS * 60 * 60 * 1000);
  return { token, hash, expiresAt };
};

export const hashEmailVerificationToken = (token: string): string =>
  crypto.createHash("sha256").update(token).digest("hex");

const PASSWORD_RESET_EXPIRES_MINUTES = 30;

// Deliberately short-lived compared to the 24h email-verification link — a
// leaked reset link is a much more sensitive thing to have sitting around.
export const createPasswordResetToken = (): { token: string; hash: string; expiresAt: Date } => {
  const token = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRES_MINUTES * 60 * 1000);
  return { token, hash, expiresAt };
};

export const hashPasswordResetToken = (token: string): string =>
  crypto.createHash("sha256").update(token).digest("hex");

export const sanitizeUser = (user: mongoose.Document): any => {
  const _user = user.toJSON();
  delete _user.password;
  return _user;
};
