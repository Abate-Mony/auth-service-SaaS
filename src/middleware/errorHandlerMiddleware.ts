import { StatusCodes } from "http-status-codes";
// import { Response, Request,NextFunction} from "express";
import { ErrorRequestHandler } from 'express';
import multer from "multer";

// multer rejects an oversized/wrong-type file by calling next(err) with a
// MulterError *before* any route handler runs — it has no statusCode of its
// own, so without this it fell through to the generic 500 branch below with
// a correct-but-oddly-served message ("File too large" as an Internal
// Server Error). Mapped to the same { msg, code } shape as every other
// custom error class in this app.
const multerErrorMessage = (err: multer.MulterError): string => {
  switch (err.code) {
    case "LIMIT_FILE_SIZE":
      return "File is too large.";
    case "LIMIT_UNEXPECTED_FILE":
      return "Unexpected file field.";
    default:
      return err.message;
  }
};

const errorHandlerMiddleware:ErrorRequestHandler = (err, req, res, next) => {
  console.error(err);

  if (err instanceof multer.MulterError) {
    res.status(StatusCodes.BAD_REQUEST).json({ msg: multerErrorMessage(err), code: err.code });
    return;
  }

  const statusCode = err.statusCode || StatusCodes.INTERNAL_SERVER_ERROR;
  const msg = err.message || "something went wrong, try again later";
  // err.code is an optional machine-readable string set by some custom
  // error classes (e.g. "INVITATION_EXPIRED") — omitted here when unset.
  res.status(statusCode).json({ msg, ...(err.code ? { code: err.code } : {}) });
};

export default errorHandlerMiddleware;
