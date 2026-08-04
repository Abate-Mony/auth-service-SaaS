import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { UnauthenticatedError } from "../errors/customErrors.js";

export interface IReqUser {
  user_id: string | mongoose.Types.ObjectId;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      user: IReqUser;
    }
  }
}
export type MiddlewareFn = (
  req: Request,
  res: Response,
  next: NextFunction,
  user?: IReqUser
) => Promise<void> | void;

// Routes using this are always mounted behind authenticateUser, so req.user
// is set by the time they run; this narrows the type and still guards at
// runtime if that assumption is ever broken.
export const getReqUser = (req: Request): IReqUser => {
  if (!req.user) throw new UnauthenticatedError("authentication invalid");
  return req.user;
};
