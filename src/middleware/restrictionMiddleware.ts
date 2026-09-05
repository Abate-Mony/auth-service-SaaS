import { HydratedDocument } from "mongoose";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import UserRestrictionModel, {
  RestrictableAction,
  UserRestriction as UserRestrictionAttrs,
} from "../models/userRestrictionModel.js";

// The model's methods/virtuals (blocks, toUserFacing, isExpired, ...) are
// attached at runtime via .methods/.virtual() but aren't reflected in
// InferSchemaType, so mongoose.model()'s inferred document type doesn't know
// about them. Declared once here rather than reimplemented anywhere they're
// used — the model itself (schema/behavior) is untouched.
interface UserRestrictionExtras {
  isExpired: boolean;
  isCurrentlyActive: boolean;
  hasPendingAppeal: boolean;
  blocks(action: RestrictableAction): boolean;
  toUserFacing(): {
    _id: unknown;
    reason: string;
    message: string;
    accessLevel: string;
    restrictions: string[];
    remedy: string;
    canAppeal: boolean;
    startsAt?: Date;
    expiresAt?: Date;
    liftedAt?: Date;
    liftReason?: string;
    appeal?: {
      submittedAt?: Date;
      message?: string;
      status?: string;
      respondedAt?: Date;
      response?: string;
    };
  };
}

export type RestrictionDoc = HydratedDocument<UserRestrictionAttrs, UserRestrictionExtras>;

declare global {
  namespace Express {
    interface Request {
      /** Set by loadRestriction. Present only when the caller has a currently-active restriction. */
      restriction?: RestrictionDoc;
    }
  }
}

// Shared by requireNotRestricted and any controller that has to branch on
// the restriction body shape itself (e.g. updateWorkerJobStatus, where the
// blocked action depends on req.body rather than the route) - keeping this
// in one place means the API response can't drift between call sites.
export const buildRestrictionResponse = (restriction: RestrictionDoc) => ({
  restricted: true as const,
  reason: restriction.reason,
  message: restriction.message,
  remedy: restriction.remedy,
  canAppeal: Boolean(restriction.canAppeal) && !restriction.appeal?.submittedAt,
  appealStatus: restriction.appeal?.status ?? null,
  expiresAt: restriction.expiresAt ?? null,
});

// Runs after authenticateUser on every authenticated route. Attaches
// req.restriction when the caller has a currently-active restriction;
// leaves it undefined otherwise (no restriction, lifted, or expired).
//
// status only ever becomes "expired" here - lazily, on whichever request
// notices first - rather than depending on a cron, so a restriction can
// never outlive its own expiresAt just because nothing swept it yet.
export const loadRestriction: MiddlewareFn = async (req, _res, next) => {
  const restriction = (await UserRestrictionModel.findOne({
    user: req.user.user_id,
    status: "active",
  })) as RestrictionDoc | null;

  if (restriction && restriction.isExpired) {
    restriction.status = "expired";
    await restriction.save();
    return next();
  }

  req.restriction = restriction ?? undefined;
  next();
};

// Route guard factory: requireNotRestricted("clock_in") 403s when the
// caller's active restriction blocks that specific action. Always defers to
// restriction.blocks() rather than re-reading accessLevel/restrictions
// directly, so this and the frontend can't drift on precedence.
//
// Never apply this to the routes that provide the way out of a restriction
// - GET /restrictions/me, POST /restrictions/me/appeal, anything under
// /documents, POST /auth/logout - or a restricted user has no path back.
export const requireNotRestricted = (action: RestrictableAction): MiddlewareFn => {
  return (req, res, next) => {
    if (req.restriction?.blocks(action)) {
      res.status(403).json(buildRestrictionResponse(req.restriction));
      return;
    }
    next();
  };
};
