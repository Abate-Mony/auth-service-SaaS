import PlatformErrorLog, { PlatformErrorSource } from "../models/PlatformErrorLog.js";

interface LogPlatformErrorParams {
  source: PlatformErrorSource;
  message: string;
  stack?: string | null;
  metadata?: unknown;
}

const MAX_STACK_LENGTH = 2000;

// Fire-and-forget by design — this is an observability write, never allowed
// to affect the caller's own control flow. Every call site that uses this
// (stripeWebhookHandler, sendMail, runCronJob) re-throws or continues exactly
// as it did before this existed; a failure writing the log itself is only
// console.error'd, never surfaced further.
export async function logPlatformError(params: LogPlatformErrorParams): Promise<void> {
  try {
    await PlatformErrorLog.create({
      source: params.source,
      message: params.message,
      stack: params.stack ? params.stack.slice(0, MAX_STACK_LENGTH) : null,
      metadata: params.metadata ?? null,
    });
  } catch (err) {
    console.error("[logPlatformError] failed to write error log:", err);
  }
}
