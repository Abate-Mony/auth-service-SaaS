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
import { generateUniqueCharacter } from "../utils/generateRandomNumbers.js";
export const login: MiddlewareFn = async (req, res) => {
  const {
    email,
    password,
  }: {
    email: string;
    password: string;
  } = req.body;
  const user = await User.findOne({ email: email });
  const isValidUser = user && (await comparePassword(password, user.password));
  if (!isValidUser) throw new UnauthenticatedError("invalid credentials");

  const token = createJWT({ userId: user.userId, role: user.role });
  const oneDay: number = 1000 * 60 * 60 * 24;
  res.cookie("token", token, setCookies(oneDay));

  res.status(StatusCodes.OK).json({ msg: "user logged in", token });
};

export const register: MiddlewareFn = async (req, res) => {
  const isFirstAccount = (await User.countDocuments()) === 0;
  req.body.role = isFirstAccount ? USER_ROLES.admin : USER_ROLES.user;
  const { password, email }: { password: string; email: string } = req.body;
  //   prevent user from creating multi account with the same email
  const isUserAlreadyExist = await User.findOne({ email });
  if (isUserAlreadyExist)
    throw new BadRequestError(`user already exist with email ${email}`);
  const hashedPassword = await hashPassword(password);
  req.body.password = hashedPassword;
  const userId = await generateUniqueCharacter({
    Model: User,
    type: "number",
    length: 8,
  });
  // console.log("this the user id", userId);
  req.body.userId = userId;

  const user = await User.create({
    ...req.body,
  });
  const token = createJWT({
    userId: user.userId,
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
