import { StatusCodes } from "http-status-codes";
import { UnauthenticatedError } from "../errors/customErrors.js";
import userModel from "../models/userModel.js";
import { sanitizeUser } from "../utils/tokenUtils.js";

export const currentUser = async (req, res) => {
  const { userId, role } = req?.user;
  const user = await userModel.findOne({  userId });
  if (!user) throw new UnauthenticatedError(`login again `);
  let Iuser = sanitizeUser(user);
  Iuser = {
    ...Iuser,
    fullname: Iuser.name,
  };
  console.log("this is the login user",Iuser,user)
  res.status(StatusCodes.OK).json({ user: Iuser });
};
