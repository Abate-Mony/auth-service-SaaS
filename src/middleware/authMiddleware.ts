import type { NextFunction, Request, Response } from "express";
import {
  UnauthenticatedError,
  UnauthorizedError
} from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import { verifyAccessToken } from "../utils/tokenUtils.js";
import { USER_ROLES } from "../utils/types.js";
// Verifies the JWT stored in the "token" cookie (web) or sent as a
// "Authorization: Bearer <token>" header (mobile, which has no shared
// cookie jar with the browser) and attaches the decoded { user_id, role }
// payload to req.user for downstream handlers/middleware. Any missing/
// invalid/expired token is normalized to a single 401 so callers can't
// distinguish "no token" from "bad token".
export const authenticateUser: MiddlewareFn = (req, _res, next) => {
  const bearer = req?.headers?.authorization;
  const token = req?.cookies?.token ?? (bearer?.startsWith("Bearer ") ? bearer.slice(7) : undefined);
  if (!token) throw new UnauthenticatedError("authentication invalid");

  try {
    const payload = verifyAccessToken(token);
    const { user_id, role ,company_id} = payload;
    req.user = { user_id, role ,company_id};
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
//
// "owner" is a strict superset of "admin" (the company founder, with every
// admin permission plus a few owner-only ones later) rather than a sibling
// role like manager/worker are to each other. Rather than appending "owner"
// to every one of the ~50 authorizePermissions("admin", ...) call sites
// across the route files, that hierarchy is enforced once, here: any route
// that allows "admin" implicitly allows "owner" too.
export const authorizePermissions = (...roles: USER_ROLES[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const userRole = req.user!.role as USER_ROLES;
    const allowed = roles.includes(userRole) || (userRole === "owner" && roles.includes("admin"));
    if (!allowed) {
      throw new UnauthorizedError("Unauthorized to access this route");
    }
    next();
  };
};

// export const checkForTestUser = (req, res, next) => {
//   if (req.user.testUser) throw new BadRequestError("Demo User. Read Only!");
//   next();
// };
