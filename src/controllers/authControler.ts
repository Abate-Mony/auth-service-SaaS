import { MiddlewareFn } from "../interfaces/expresstype.js";
import { comparePassword, hashPassword } from "../utils/passwordUtils.js";
import User from "../models/userModel.js";
import {
  BadRequestError,
  UnauthenticatedError,
} from "../errors/customErrors.js";
import { createAccessToken, createRefreshToken, hashRefreshToken, sanitizeUser } from "../utils/tokenUtils.js";
import { StatusCodes } from "http-status-codes";
import { USER_ROLES, UserroleTypes } from "../utils/constant.js";
import { setCookies } from "../utils/cookieUtils.js";
import { OAuth2Client } from "google-auth-library";
import Company from "../models/company.js";
import mongoose from "mongoose";

const ACCESS_TOKEN_COOKIE_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_COOKIE_MS = (Number(process.env.REFRESH_TOKEN_EXPIRES_IN_DAYS) || 30) * 24 * 60 * 60 * 1000;

// Issues an access + refresh token pair for `user`, persists the refresh
// token's hash on the user doc (so it can be looked up/revoked later), and
// sets both as httpOnly cookies on `res`.
const issueTokens = async (user: mongoose.Document & { _id: any; role: string; company?: any }, res: import("express").Response) => {
  const accessToken = createAccessToken({
    user_id: user._id.toString(),
    role: user.role,
    company_id: user.company as unknown as string,
  });
  const { token: refreshToken, hash, expiresAt } = createRefreshToken();

  await User.updateOne(
    { _id: user._id },
    { refreshToken: hash, refreshTokenExpiresAt: expiresAt }
  );

  res.cookie("token", accessToken, setCookies(ACCESS_TOKEN_COOKIE_MS));
  res.cookie("refreshToken", refreshToken, setCookies(REFRESH_TOKEN_COOKIE_MS));
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

  await issueTokens(user, res);

  res.status(StatusCodes.OK).json({ msg: "user logged in", user: sanitizeUser(user) });
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

  // 2. Create Admin User
  const user = await User.create({
    fullname,
    email,
    password: hashedPassword,
    phone: phone || "0000-0000-0000",
    role: "admin",
  });

  // 3. Create Company with manual rollback on failure
  let company;
  try {
    company = await Company.create({
      name: companyName,
      businessType,
      size: companySize,
      website: website || "",
      country: country || "",
      phone: phone || "",
      owner: user._id,
      isActive: true,
    });
  } catch (error) {
    // If company creation fails, delete the created user to prevent orphaned data
    await User.findByIdAndDelete(user._id);
    throw error;
  }

  // 4. Attach company ID back to User
  user.company = company._id;
  await user.save();

  // 5. Issue Token & Cookie
  await issueTokens(user, res);

  res.status(StatusCodes.CREATED).json({
    msg: "User and company created successfully",
    user: {
      ...sanitizeUser(user),
      company: company._id,
    },
  });
};
// Exchanges a still-valid refresh token cookie for a new access token
// (rotating the refresh token too, so a stolen-and-replayed old refresh
// token stops working the moment the legitimate client refreshes).
export const refresh: MiddlewareFn = async (req, res) => {
  const { refreshToken } = req.cookies;
  if (!refreshToken) throw new UnauthenticatedError("authentication invalid");

  const hash = hashRefreshToken(refreshToken);
  const user = await User.findOne({ refreshToken: hash }).select("+refreshToken +refreshTokenExpiresAt");

  if (!user || !user.refreshTokenExpiresAt || user.refreshTokenExpiresAt < new Date()) {
    res.cookie("token", "logout", setCookies());
    res.cookie("refreshToken", "logout", setCookies());
    throw new UnauthenticatedError("authentication invalid");
  }

  await issueTokens(user, res);

  res.status(StatusCodes.OK).json({ success: true, msg: "token refreshed" });
};

export const logout: MiddlewareFn = async (req, res) => {
  const { refreshToken } = req.cookies;
  if (refreshToken) {
    await User.updateOne(
      { refreshToken: hashRefreshToken(refreshToken) },
      { $unset: { refreshToken: "", refreshTokenExpiresAt: "" } }
    );
  }

  res.cookie("token", "logout", setCookies());
  res.cookie("refreshToken", "logout", setCookies());
  res.status(StatusCodes.OK).json({ msg: "user logged out!" });
};
