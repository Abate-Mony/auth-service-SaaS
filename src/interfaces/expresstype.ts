import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
interface IReqUser {
  user_id: typeof mongoose.Types.ObjectId;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: IReqUser;
    }
  }
}
export type MiddlewareFn = (
  req?: Request,
  res?: Response,
  next?: NextFunction
) => Promise<void> | void;
