// middleware/apiKeyAuthMiddleware.ts
//
// Authenticates an external caller (a company's own booking website, etc.)
// by API key instead of a user JWT — see routes/externalRouter.ts, which
// exists specifically for these callers and never accepts a user session.
import type { NextFunction, Request, Response } from "express";
import ApiKey from "../models/apiKeyModel.js";
import { UnauthenticatedError } from "../errors/customErrors.js";
import { hashApiKey, looksLikeApiKey } from "../utils/apiKeys.js";

export interface ExternalAuth {
  companyId: string;
  apiKeyId: string;
}

declare global {
  namespace Express {
    interface Request {
      externalAuth?: ExternalAuth;
    }
  }
}

export const authenticateApiKey = async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  const raw = header?.startsWith("Bearer ") ? header.slice(7) : undefined;

  if (!looksLikeApiKey(raw)) {
    throw new UnauthenticatedError("Missing or invalid API key.");
  }

  const key = await ApiKey.findOne({ keyHash: hashApiKey(raw), isActive: true });
  if (!key) {
    throw new UnauthenticatedError("Missing or invalid API key.");
  }

  req.externalAuth = { companyId: key.company.toString(), apiKeyId: key._id.toString() };

  // Best-effort, never blocks the request on a write failure.
  ApiKey.updateOne({ _id: key._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});

  next();
};

export const getExternalAuth = (req: Request): ExternalAuth => {
  if (!req.externalAuth) throw new UnauthenticatedError("Missing or invalid API key.");
  return req.externalAuth;
};
