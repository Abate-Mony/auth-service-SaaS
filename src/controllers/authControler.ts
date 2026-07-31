import { MiddlewareFn } from "../interfaces/expresstype.js";
import { comparePassword, hashPassword } from "../utils/passwordUtils.js";
import User from "../models/userModel.js";
import {
  BadRequestError,
  UnauthenticatedError,
} from "../errors/customErrors.js";
import { createJWT, sanitizeUser } from "../utils/tokenUtils.js";
import { StatusCodes } from "http-status-codes";
import { USER_ROLES } from "../utils/constant.js";
import { setCookies } from "../utils/cookieUtils.js";
import { OAuth2Client } from "google-auth-library";



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
  console.log("user _id to string : ", user._id.toString())

  const token = createJWT({
    user_id: user._id.toString(),
    role: user.role,
  });
  const oneDay: number = 1000 * 60 * 60 * 24;
  res.cookie("token", token, setCookies(oneDay));

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
  console.log("this is body request :", req.body)
  const user = await User.findOne({ email: email }).select("+password");
  console.log("this is the user : ", user)
  const isValidUser = user && (await comparePassword(password, user.password));
  if (!isValidUser) throw new UnauthenticatedError("invalid credentials");

  const token = createJWT({ user_id: user._id.toString(), role: user.role });
  const oneDay: number = 1000 * 60 * 60 * 24;
  res.cookie("token", token, setCookies(oneDay));
  console.log("token", token)
  res.status(StatusCodes.OK).json({ msg: "user logged in", token, user: sanitizeUser(user) });
};

export const register: MiddlewareFn = async (req, res) => {
  const isFirstAccount = (await User.countDocuments()) === 0;
  req.body.role = isFirstAccount ? USER_ROLES.admin : USER_ROLES.user;
  const { password, email }: { password: string; email: string } = req.body;
  console.log("this is req.body", req.body)
  //   prevent user from creating multi account with the same email
  const isUserAlreadyExist = await User.findOne({ email });
  if (isUserAlreadyExist)
    throw new BadRequestError(`user already exist with email ${email}`);
  console.log("password : ", password)
  const hashedPassword = await hashPassword(password);
  req.body.password = hashedPassword;

  // console.log("this the user id", userId);


  const user = await User.create({
    ...req.body,
  });
  const token = createJWT({
    user_id: String(user._id),
    role: user.role,
  });
  const oneDay = 1000 * 60 * 60 * 24;
  res.cookie("token", token, setCookies(oneDay));
  res.status(StatusCodes.CREATED).json({
    msg: "user created",
    user: {
      fullname: sanitizeUser(user).name,
      ...sanitizeUser(user),
    },
  });
};

export const logout: MiddlewareFn = (_, res) => {
  res.cookie("token", "logout", setCookies());
  res.status(StatusCodes.OK).json({ msg: "user logged out!" });
};
