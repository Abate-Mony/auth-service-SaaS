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
import { logActivity } from "./logActivity.js";

const TERMINAL_ASSIGNMENT_STATUSES = ["completed", "declined", "cancelled"];

/**
 * Call this right after any assignment on a job reaches a terminal status —
 * from the worker's own clock-out and from the auto-close-abandoned-shifts
 * cron alike, so the two paths can't drift into different completion
 * behaviour. Safe to call unconditionally; it's a no-op unless the job is
 * actually ready.
 */
export async function maybeCompleteJob(jobId: unknown): Promise<void> {
  const job = await Job.findOne({ _id: jobId as string, isDeleted: false, isTemplate: false }).select("status");
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
}
