import { MiddlewareFn } from "../interfaces/expresstype.js";
import { UnauthenticatedError, UnauthorizedError } from "../errors/customErrors.js";
import User from "../models/userModel.js";
import { PlatformRole, PLATFORM_ROLES } from "../utils/platformRoles.js";

// The identity of whoever is making a platform-admin request, loaded fresh
// from the database (see requirePlatformRole below for why).
export interface PlatformActor {
  id: string;
  email: string;
  fullname: string;
  platformRole: PlatformRole;
}

declare global {
  namespace Express {
    interface Request {
      /** Set by requirePlatformRole. Only present on routes under /api/v1/platform. */
      platformActor?: PlatformActor;
    }
  }
}

// Route guard factory for the platform admin API: requirePlatformRole("super_admin")
// throws unless the caller currently holds one of the given platform roles.
//
// Deliberately NOT modeled on authorizePermissions (which trusts req.user.role
// straight off the JWT payload). platformRole is not part of the JWT payload
// at all, and on purpose: authenticateUser's access tokens are stateless and
// live for up to 15 minutes (see tokenUtils.ts), so a claim embedded in one
// would let a just-revoked platform admin keep acting on any tenant's data
// for up to 15 more minutes. Platform routes see far lower traffic than the
// rest of the API (internal staff only), so the cost of one extra indexed
// findById per request is worth paying for revocation that takes effect on
// the very next request instead of waiting for a token to expire.
export const requirePlatformRole = (...allowedRoles: PlatformRole[]): MiddlewareFn => {
  return async (req, _res, next) => {
    if (!req.user?.user_id) {
      throw new UnauthenticatedError("Authentication required");
    }

    const actor = await User.findById(req.user.user_id).select("email fullname platformRole isActive");
    if (!actor || actor.isActive === false) {
      throw new UnauthenticatedError("Authentication required");
    }

    const platformRole = actor.platformRole as PlatformRole | null | undefined;
    if (!platformRole || !PLATFORM_ROLES.includes(platformRole) || !allowedRoles.includes(platformRole)) {
      throw new UnauthorizedError("Platform access required");
    }

    req.platformActor = {
      id: actor._id.toString(),
      email: actor.email,
      fullname: actor.fullname,
      platformRole,
    };
    next();
  };
};
