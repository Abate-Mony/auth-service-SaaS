import jwt, { Secret, SignOptions } from "jsonwebtoken";
import mongoose from "mongoose";
// import { IUser } from "../interfaces/models/user.js";

interface Payload {
  user_id: string | mongoose.Types.ObjectId;
  role: string;
  company_id: string | mongoose.Types.ObjectId
}
export const createJWT = (payload: Payload): string => {
  const token = jwt.sign(payload, process.env.JWT_SECRET as Secret, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  } as SignOptions);
  return token;
};

export const verifyJWT = (token: string): Payload => {
  const decoded = jwt.verify(token, process.env.JWT_SECRET as Secret);
  return decoded as Payload;
};

export const sanitizeUser = (user: mongoose.Document): any => {
  const _user = user.toJSON();
  delete _user.password;
  return _user;
};
