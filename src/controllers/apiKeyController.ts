// controllers/apiKeyController.ts
//
// Company-side management of external-integration API keys — create,
// list, revoke. See utils/apiKeys.ts for generation/hashing and
// routes/externalRouter.ts for where the keys are actually used.
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import ApiKey from "../models/apiKeyModel.js";
import { assertFeatureEnabledForCompany } from "../utils/planLimits.js";
import { generateApiKey } from "../utils/apiKeys.js";

const createApiKeySchema = z
  .object({
    name: z.string().trim().min(1, "Give this key a name.").max(80),
  })
  .strict();

const parseOrThrow = <T>(schema: z.ZodSchema<T>, body: unknown): T => {
  try {
    return schema.parse(body);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new BadRequestError(err.issues[0]?.message ?? "Invalid request.");
    }
    throw err;
  }
};

// Never returns keyHash — the raw key is shown exactly once, in
// createApiKeyHandler's response, and is unrecoverable after that.
const serializeApiKey = (k: any) => ({
  _id: k._id,
  name: k.name,
  keyPrefix: k.keyPrefix,
  isActive: k.isActive,
  lastUsedAt: k.lastUsedAt,
  createdAt: k.createdAt,
  revokedAt: k.revokedAt,
});

export const getApiKeys: MiddlewareFn = async (req, res) => {
  const companyId = req.user.company_id;
  const keys = await ApiKey.find({ company: companyId }).sort({ createdAt: -1 }).lean();
  res.status(StatusCodes.OK).json({ success: true, apiKeys: keys.map(serializeApiKey) });
};

export const createApiKey: MiddlewareFn = async (req, res) => {
  const data = parseOrThrow(createApiKeySchema, req.body);
  const companyId = req.user.company_id;
  await assertFeatureEnabledForCompany(companyId, "externalApiAccess");

  const generated = generateApiKey();

  const key = await ApiKey.create({
    company: companyId,
    name: data.name,
    keyHash: generated.hash,
    keyPrefix: generated.displayPrefix,
    createdBy: req.user.user_id,
  });

  res.status(StatusCodes.CREATED).json({
    success: true,
    apiKey: serializeApiKey(key),
    // Only place this ever appears — the frontend must show/copy it now
    // and never fetch it again, because it can't: only the hash is stored.
    rawKey: generated.raw,
  });
};

export const revokeApiKey: MiddlewareFn = async (req, res) => {
  const companyId = req.user.company_id;
  const key = await ApiKey.findOne({ _id: req.params.id, company: companyId });
  if (!key) throw new NotFoundError("API key not found.");

  key.isActive = false;
  key.revokedAt = new Date();
  await key.save();

  res.status(StatusCodes.OK).json({ success: true, apiKey: serializeApiKey(key) });
};
