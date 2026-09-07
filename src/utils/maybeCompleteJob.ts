// utils/maybeCompleteJob.ts
//
// Job.status is never touched by a worker clocking out — only their own
// JobAssignment.status changes. That's a real gap now that fixed-price
// invoicing depends on Job.status === "completed": nothing was ever going
// to make that job eligible to bill without a manager manually editing it.
//
// Confirmed completion rule: a published job auto-completes once every one
// of its assignments has reached a terminal state (completed/declined/
// cancelled) AND at least one of them actually completed — a job everyone
// declined never auto-completes, and a job with anyone still pending/
// accepted/in-progress stays published.
import Job from "../models/jobModel.js";
import JobAssignment from "../models/JobAssignment.js";
import userModel from "../models/userModel.js";
import { logActivity } from "./logActivity.js";
import { shouldNotify } from "../services/notificationPreferenceService.js";
import { sendPushToUser } from "./webPush.js";
import { sendExpoPushToUser } from "./expoPush.js";
import { notifyUser } from "./notifyUser.js";

const TERMINAL_ASSIGNMENT_STATUSES = ["completed", "declined", "cancelled"];

async function notifyManagerJobCompleted(job: { _id: unknown; title: string; createdBy: unknown; company: unknown }) {
  const manager = await userModel.findOne({ _id: job.createdBy as string }).select("email");
  if (!manager) return;

  const managerId = manager._id.toString();
  const canPush = await shouldNotify(managerId, "job_completed", "push");

  const title = "Job completed";
  const body = `${job.title} is finished — every assigned worker has clocked out.`;
  const link = `/jobs/${job._id}`;

  await Promise.all([
    canPush
      ? sendPushToUser(managerId, { title, body, tag: `job-completed-${job._id}`, url: link })
      : Promise.resolve(),
    canPush
      ? sendExpoPushToUser(managerId, { title, body, tag: `job-completed-${job._id}`, url: link })
      : Promise.resolve(),
    notifyUser({ userId: managerId, companyId: job.company, event: "job_completed", title, body, link }),
  ]);
}

/**
 * Call this right after any assignment on a job reaches a terminal status —
 * from the worker's own clock-out and from the auto-close-abandoned-shifts
 * cron alike, so the two paths can't drift into different completion
 * behaviour. Safe to call unconditionally; it's a no-op unless the job is
 * actually ready.
 */
export async function maybeCompleteJob(jobId: unknown): Promise<void> {
  const job = await Job.findOne({ _id: jobId as string, isDeleted: false, isTemplate: false }).select("status title createdBy company");
  if (!job || job.status !== "published") return;

  const assignments = await JobAssignment.find({ job: jobId as string, isDeleted: false }).select("status");
  if (!assignments.length) return;

  const allTerminal = assignments.every(a => TERMINAL_ASSIGNMENT_STATUSES.includes(a.status));
  const anyCompleted = assignments.some(a => a.status === "completed");
  if (!allTerminal || !anyCompleted) return;

  job.status = "completed";
  await job.save();

  // System-triggered, not a specific person's action — actor: null marks it
  // isSystem, same convention as the auto-close cron's own activity entries.
  await logActivity({
    job: job._id,
    type: "job_updated",
    actor: null,
    changes: [{ field: "status", from: "published", to: "completed" }],
    metadata: { reason: "all assigned workers finished" },
  });

  // Every assigned worker has now finished (whether or not any of them got
  // individually flagged for overtime review) — the manager should hear
  // about the job itself wrapping up, not just infer it from separate
  // per-worker notifications.
  await notifyManagerJobCompleted({ _id: job._id, title: job.title, createdBy: job.createdBy, company: job.company }).catch(err =>
    console.error(`Failed to notify manager of job completion for job ${job._id}:`, err)
  );
}
