import CronJobStatus from "../models/CronJobStatus.js";
import { logPlatformError } from "./logPlatformError.js";
import { runDailyOccurrenceGeneration } from "./runDailyOccurrenceGeneration.js";
import { sendUpcomingShiftReminders } from "./sendUpcomingShiftReminders.js";
import { sendDayBeforeShiftReminders } from "./sendDayBeforeShiftReminders.js";
import { sendUnfilledShiftDayBeforeAlerts } from "./sendUnfilledShiftDayBeforeAlerts.js";
import { sendUnfilledShiftUrgentAlerts } from "./sendUnfilledShiftUrgentAlerts.js";
import { sendJobStartingSoonCreatorAlerts } from "./sendJobStartingSoonCreatorAlerts.js";
import { autoCloseAbandonedShifts } from "./autoCloseAbandonedShifts.js";
import { markMissedShifts } from "./markMissedShifts.js";
import { sendOverduePaymentReminders } from "./sendPaymentReminders.js";
import { sendStaleQuoteRequestReminders } from "./sendStaleQuoteRequestReminders.js";
import { expireTrials } from "./expireTrials.js";
import { checkPendingEmailDomains } from "./checkPendingEmailDomains.js";
import { generateRecurringInvoices } from "../services/invoice/recurringInvoiceGenerator.js";

export interface CronJobDefinition {
  name: string;
  label: string;
  // Human-readable description of the cron.schedule(...) expression below
  // — kept as a static string here rather than re-deriving it from the cron
  // expression at render time, since server.ts's schedule strings are the
  // actual source of truth and this is just a label for the platform UI.
  schedule: string;
  fn: () => Promise<void>;
}

// Single source of truth for every scheduled job in the app: server.ts
// schedules against this list (so the cron.schedule(...) calls and this
// registry can never drift apart), and the platform console's "run now"
// endpoint only ever invokes a job by looking it up here — never by
// constructing/eval'ing a function from an arbitrary request body.
export const 
CRON_JOBS: CronJobDefinition[] = [
  { name: "runDailyOccurrenceGeneration", label: "Generate recurring job occurrences", schedule: "Daily at 01:00 UTC", fn: runDailyOccurrenceGeneration },
  { name: "sendUpcomingShiftReminders", label: "Send upcoming shift reminders", schedule: "Every minute", fn: sendUpcomingShiftReminders },
  { name: "sendDayBeforeShiftReminders", label: "Send day-before shift reminders", schedule: "Every minute", fn: sendDayBeforeShiftReminders },
  { name: "sendUnfilledShiftDayBeforeAlerts", label: "Alert managers of unfilled shifts (day before)", schedule: "Every minute", fn: sendUnfilledShiftDayBeforeAlerts },
  { name: "sendUnfilledShiftUrgentAlerts", label: "Alert managers of unfilled shifts (urgent)", schedule: "Every minute", fn: sendUnfilledShiftUrgentAlerts },
  { name: "sendJobStartingSoonCreatorAlerts", label: "Alert job creators of jobs starting soon", schedule: "Every minute", fn: sendJobStartingSoonCreatorAlerts },
  { name: "autoCloseAbandonedShifts", label: "Auto-close abandoned shifts", schedule: "Every minute", fn: autoCloseAbandonedShifts },
  { name: "markMissedShifts", label: "Mark missed shifts", schedule: "Every minute", fn: markMissedShifts },
  { name: "sendOverduePaymentReminders", label: "Send overdue payment reminders", schedule: "Daily at 08:00 UTC", fn: sendOverduePaymentReminders },
  { name: "sendStaleQuoteRequestReminders", label: "Send stale quote request reminders", schedule: "Hourly", fn: sendStaleQuoteRequestReminders },
  { name: "generateRecurringInvoices", label: "Generate recurring invoices", schedule: "Daily at 06:00 UTC", fn: generateRecurringInvoices },
  { name: "expireTrials", label: "Expire trials", schedule: "Daily at 02:00 UTC", fn: expireTrials },
  { name: "checkPendingEmailDomains", label: "Check pending email domains", schedule: "Every 10 minutes", fn: checkPendingEmailDomains },
];

const CRON_JOBS_BY_NAME = new Map(CRON_JOBS.map(job => [job.name, job]));

export function getCronJobDefinition(name: string): CronJobDefinition | undefined {
  return CRON_JOBS_BY_NAME.get(name);
}

// Wraps a registered job's run with persisted status tracking. Scheduled
// calls and the platform console's manual "run now" both go through this —
// same function, different `triggeredBy` — so there's exactly one place
// that decides what "success"/"failed" means for a cron run.
export async function runCronJob(name: string, triggeredBy: "schedule" | "manual"): Promise<void> {
  const job = CRON_JOBS_BY_NAME.get(name);
  if (!job) throw new Error(`Unknown cron job: ${name}`);

  const startedAt = new Date();
  await CronJobStatus.updateOne(
    { name },
    { $set: { lastRunAt: startedAt, lastStatus: "running", lastTriggeredBy: triggeredBy }, $inc: { runCount: 1 } },
    { upsert: true }
  );

  try {
    await job.fn();
    const finishedAt = new Date();
    await CronJobStatus.updateOne(
      { name },
      { $set: { lastFinishedAt: finishedAt, lastStatus: "success", lastDurationMs: finishedAt.getTime() - startedAt.getTime(), lastError: null } }
    );
  } catch (err) {
    const finishedAt = new Date();
    const message = err instanceof Error ? err.message : "Unknown error";
    await CronJobStatus.updateOne(
      { name },
      { $set: { lastFinishedAt: finishedAt, lastStatus: "failed", lastDurationMs: finishedAt.getTime() - startedAt.getTime(), lastError: message }, $inc: { failCount: 1 } }
    );
    await logPlatformError({
      source: "cron",
      message,
      stack: err instanceof Error ? err.stack : null,
      metadata: { jobName: name, triggeredBy },
    });
    // Re-thrown so a manual "run now" request can surface the failure to
    // the admin who triggered it; server.ts's scheduled calls below already
    // console.error on an uncaught rejection the same way the bare function
    // calls used to.
    throw err;
  }
}
