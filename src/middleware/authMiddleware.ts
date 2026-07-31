import {
  UnauthenticatedError,
  UnauthorizedError,
  BadRequestError,
} from "../errors/customErrors.js";
import { verifyJWT } from "../utils/tokenUtils.js";
import { USER_ROLES } from "../utils/types.js";

export const authenticateUser = (req, res, next) => {
  const { token } = req?.cookies;
  if (!token) throw new UnauthenticatedError("authentication invalid");

  try {
    const payload = verifyJWT(token);
    console.log("in authmiddleware :",payload)
    const { user_id, role } = payload;
    req.user = { user_id, role };
    next();
  } catch (error) {
    throw new UnauthenticatedError("authentication invalid");
  }
};

export const authorizePermissions = (...roles: USER_ROLES[])  => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      throw new UnauthorizedError("Unauthorized to access this route");
    }
    next();
  };
};

export const checkForTestUser = (req, res, next) => {
  if (req.user.testUser) throw new BadRequestError("Demo User. Read Only!");
  next();
};
