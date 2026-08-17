import type { NextFunction, Request, Response } from "express";
import {
  UnauthenticatedError,
  UnauthorizedError
} from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import { verifyAccessToken } from "../utils/tokenUtils.js";
import { USER_ROLES } from "../utils/types.js";
// Verifies the JWT stored in the "token" cookie and attaches the decoded
// { user_id, role } payload to req.user for downstream handlers/middleware.
// Any missing/invalid/expired token is normalized to a single 401 so callers
// can't distinguish "no token" from "bad token".
export const authenticateUser: MiddlewareFn = (req, _res, next) => {
  const { token } = req?.cookies;
  if (!token) throw new UnauthenticatedError("authentication invalid");

  try {
    const payload = verifyAccessToken(token);
    const { user_id, role ,company_id} = payload;
    req.user = { user_id, role ,company_id};
    // console.log("payload : ", payload)
    next();
  } catch (error) {
    throw new UnauthenticatedError("authentication invalid");
  }
};

// Route guard factory: authorizePermissions("admin", "manager") returns
// middleware that 403s unless authenticateUser has already run and set
// req.user.role to one of the allowed roles. role is typed as a plain
// string on IReqUser (mirroring the Mongoose schema), so it's asserted to
// USER_ROLES here - the schema's enum guarantees the runtime value matches.
export const authorizePermissions = (...roles: USER_ROLES[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!roles.includes(req.user!.role as USER_ROLES)) {
      throw new UnauthorizedError("Unauthorized to access this route");
    }
    next();
  };
};

// export const checkForTestUser = (req, res, next) => {
//   if (req.user.testUser) throw new BadRequestError("Demo User. Read Only!");
//   next();
// };
