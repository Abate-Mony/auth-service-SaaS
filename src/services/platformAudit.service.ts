import type { Request } from "express";
import PlatformAuditLog, { PlatformAuditAction } from "../models/PlatformAuditLog.js";
import type { PlatformActor } from "../middleware/platformAuthMiddleware.js";

interface RecordPlatformAuditParams {
  req: Request;
  actor: PlatformActor;
  action: PlatformAuditAction;
  targetType: string;
  targetId: string;
  company?: string | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  result: "success" | "failed" | "denied";
  metadata?: unknown;
}

// Every sensitive platform mutation calls this after (or instead of, on a
// denied/failed attempt) the mutation itself. Awaited rather than truly
// fire-and-forget so audit list/detail reads immediately after a mutation
// see it — but a write failure here is logged loudly and swallowed rather
// than thrown, the same tradeoff utils/logActivity.ts makes: the mutation
// itself already succeeded (or the caller already knows it was denied), and
// a transient audit-write hiccup shouldn't turn that into a 500 for the
// admin performing it.
export const recordPlatformAudit = async (params: RecordPlatformAuditParams): Promise<void> => {
  const { req, actor, ...rest } = params;
  try {
    await PlatformAuditLog.create({
      actor: actor.id,
      actorEmail: actor.email,
      actorPlatformRole: actor.platformRole,
      company: rest.company ?? null,
      reason: rest.reason ?? null,
      before: rest.before ?? null,
      after: rest.after ?? null,
      metadata: rest.metadata ?? null,
      action: rest.action,
      targetType: rest.targetType,
      targetId: rest.targetId,
      result: rest.result,
      source: {
        ip: req.ip ?? null,
        userAgent: (req.headers["user-agent"] as string | undefined)?.slice(0, 500) ?? null,
      },
    });
  } catch (err) {
    console.error("[platformAudit] failed to write audit record:", err);
  }
};
