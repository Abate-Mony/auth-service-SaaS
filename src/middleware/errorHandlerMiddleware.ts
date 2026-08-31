import { StatusCodes } from "http-status-codes";
// import { Response, Request,NextFunction} from "express";
import { ErrorRequestHandler } from 'express';
const errorHandlerMiddleware:ErrorRequestHandler = (err, req, res, next) => {
  console.log("error in the app ",err);
  const statusCode = err.statusCode || StatusCodes.INTERNAL_SERVER_ERROR;
  const msg = err.message || "something went wrong, try again later";
  // err.code is an optional machine-readable string set by some custom
  // error classes (e.g. "INVITATION_EXPIRED") — omitted here when unset.
  res.status(statusCode).json({ msg, ...(err.code ? { code: err.code } : {}) });
};

export default errorHandlerMiddleware;
