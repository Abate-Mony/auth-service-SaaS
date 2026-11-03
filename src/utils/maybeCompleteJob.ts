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
import Client from "../models/clientModel.js";
import Company from "../models/company.js";
import { logActivity } from "./logActivity.js";
import { shouldNotify } from "../services/notificationPreferenceService.js";
import { sendPushToUser } from "./webPush.js";
import { sendExpoPushToUser } from "./expoPush.js";
import { notifyUser } from "./notifyUser.js";
import { notifyClientBooking } from "./notifyClientBooking.js";
import { sendBookingCompletedEmail } from "./mailTemplates.js";

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
 * from the worker's own clock-out, the auto-close-abandoned-shifts cron,
 * and reviewAssignmentOvertime alike, so none of those paths can drift into
 * different completion behaviour. Safe to call unconditionally; it's a
 * no-op unless the job has something new to do.
 *
 * Two separate things happen here, on separate conditions:
 *  1. Job.status flips published -> completed once every assignment is
 *     terminal. This already happens even while an assignment's overtime
 *     is still "pending" review — fixed-price invoicing eligibility reads
 *     Job.status, and a fixed price doesn't change based on actual hours,
 *     so there's no reason to hold that back. Hourly billing is separately
 *     and already safe regardless: services/invoice/eligibility.ts excludes
 *     any assignment with overtimeStatus "pending" from what it bills.
 *  2. The CLIENT gets told "booking completed" only once nothing on the
 *     job is still pending review — telling them it's finished while a
 *     manager might still reject/adjust the hours is the actual premature
 *     thing here, not the internal status. clientCompletedNotifiedAt makes
 *     this idempotent across the (potentially many) times this function
 *     gets called for the same job as each assignment/review resolves.
 */
export async function maybeCompleteJob(jobId: unknown): Promise<void> {
  const job = await Job.findOne({ _id: jobId as string, isDeleted: false, isTemplate: false })
    .select("status title createdBy company client date clientCompletedNotifiedAt");
  if (!job) return;

  const assignments = await JobAssignment.find({ job: jobId as string, isDeleted: false }).select("status overtimeStatus");
  if (!assignments.length) return;

  if (job.status === "published") {
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
    // per-worker notifications. Fires immediately, unlike the client
    // notification below — a manager needs to know now if review is
    // pending, not once it's resolved.
    await notifyManagerJobCompleted({ _id: job._id, title: job.title, createdBy: job.createdBy, company: job.company }).catch(err =>
      console.error(`Failed to notify manager of job completion for job ${job._id}:`, err)
    );
  }

  if (job.status !== "completed" || job.clientCompletedNotifiedAt || !job.client) return;
  if (assignments.some(a => a.overtimeStatus === "pending")) return;

  job.clientCompletedNotifiedAt = new Date();
  await job.save();

  await notifyClientBooking({
    companyId: job.company, clientId: job.client,
    event: "booking_completed",
    title: "Booking completed",
    body: `${job.title} has been completed.`,
    link: `/bookings/${job._id}`,
  }).catch(err => console.error(`Failed to notify client of job completion for job ${job._id}:`, err));

  void sendClientCompletionEmail(job as { _id: unknown; title: string; company: unknown; client: unknown; date: Date });
}

async function sendClientCompletionEmail(job: { _id: unknown; title: string; company: unknown; client: unknown; date: Date }) {
  try {
    const [client, company] = await Promise.all([
      Client.findById(job.client as string).select("billingEmail contacts").lean(),
      Company.findById(job.company as string).select("name emailSettings").lean(),
    ]);
    const billingEmail = client?.billingEmail;
    if (!billingEmail) return;

    await sendBookingCompletedEmail({
      to: billingEmail,
      company: company ?? { name: "OnClockly" },
      clientContactName: client.contacts?.find((c: any) => c.isPrimary)?.name ?? client.contacts?.[0]?.name,
      jobTitle: job.title,
      date: job.date,
    });
  } catch (err) {
    console.error(`Failed to send booking-completed email for job ${job._id}:`, err);
  }
}
