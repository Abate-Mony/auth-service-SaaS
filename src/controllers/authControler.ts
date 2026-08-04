import { MiddlewareFn } from "../interfaces/expresstype.js";
import { comparePassword, hashPassword } from "../utils/passwordUtils.js";
import User from "../models/userModel.js";
import {
  BadRequestError,
  UnauthenticatedError,
} from "../errors/customErrors.js";
import { createJWT, sanitizeUser } from "../utils/tokenUtils.js";
import { StatusCodes } from "http-status-codes";
import { USER_ROLES, UserroleTypes } from "../utils/constant.js";
import { setCookies } from "../utils/cookieUtils.js";
import { OAuth2Client } from "google-auth-library";
import Company from "../models/company.js";



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
  console.log("this is the register route body :", req.body)
  //    name: 'Ako Bate',
  // [1]   email: 'akobateemmanuel@gmail.com',
  // [1]   password: 'akobateemmanuel@gmail.com',
  // [1]   confirmPassword: 'akobateemmanuel@gmail.com',
  // [1]   companyName: 'company name ',
  // [1]   businessType: 'Cleaning Company',
  // [1]   companySize: '1–10 workers',
  // [1]   website: 'example.com',
  // [1]   phone: '99999999999',
  // [1]   country: 'United Kingdom'

  // return res.status(StatusCodes.OK).json({ msg: "register route is working" });
  // req.body.role = isFirstAccount ? USER_ROLES.admin : USER_ROLES.user;
  const { password, email, name }: { password: string; email: string; role: UserroleTypes; name: string } = req.body;
  req.body.fullname = name.trim();
  // if (!["admin", "moderator", "worker"].includes(role)) {
  //   throw new BadRequestError(`Invalid role: ${role}. Must be one of: admin, user, moderator, worker.`);
  // }
  req.body.role = "admin"//role when creating an account from the register route, it will always be an admin account. Other accounts can be created by the admin account.
  // console.log("this is req.body", req.body)
  //   prevent user from creating multi account with the same email
  const isUserAlreadyExist = await User.findOne({ email });
  if (isUserAlreadyExist)
    throw new BadRequestError(`user already exist with email ${email}`);
  const hashedPassword = await hashPassword(password);
  req.body.password = hashedPassword;

  const user = await User.create({
    ...req.body,
  });
  // creating company and assigning the company id to the user is now handled in the companyController.ts file, so we don't need to do it here anymore. The register route will only create a user account, and the company creation will be handled separately.
  const company = await Company.create({
    name: req.body.companyName,
    type: req.body.businessType,
    size: req.body.companySize,
    website: req.body.website || "",
    country: req.body.country || "",
    phone: req.body.phone || "",
    owner: user._id, // we will update this later after the user is created
    isActive: true,
    businessType: req.body.businessType,

  });
  if (!company) {
    await user.deleteOne({ _id: user._id });
    throw new BadRequestError("company creation failed");
  }
  const token = createJWT({
    user_id: user._id,
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
