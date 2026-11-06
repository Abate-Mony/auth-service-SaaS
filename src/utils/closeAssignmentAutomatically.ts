// Force-closes an assignment the worker never clocked out of — either the
// auto-close-abandoned-shifts cron (a buffer deadline has passed) or a
// worker clocking into their next shift while a previous one is still
// "in-progress" past its own scheduled end (see workerController.ts's
// updateWorkerJobStatus). Both callers need identical safety properties, so
// this is the one place that implements them:
//
//  - A recoverable LEASE WITH AN OWNERSHIP TOKEN, not a bare boolean. A
//    timestamp alone still races: if one process's handling of an
//    assignment outruns the lease window, a second process can reclaim it
//    while the first is still mid-flight, and an unconditional final write
//    from either would succeed — both would close and notify. Pairing the
//    timestamp with a per-attempt token, and making the final transition a
//    findOneAndUpdate conditioned on that exact token, means only whichever
//    process still legitimately holds the *current* token can ever commit.
//  - effectiveClockOutAt is validated before anything is written.
//  - The critical state transition is ONE conditional update. Everything
//    after it (activity log, maybeCompleteJob, notifications) is a separate,
//    best-effort phase — those are non-atomic side effects against an
//    *already-closed* assignment, and a failure there must never be
//    confused with the close itself failing, nor re-attempted against an
//    assignment that already left "in-progress".
import mongoose from "mongoose";
import Job from "../models/jobModel.js";
import JobAssignment from "../models/JobAssignment.js";
import userModel from "../models/userModel.js";
import { computeWorkedMinutes } from "./computeWorkedMinutes.js";
import { logActivity } from "./logActivity.js";
import { maybeCompleteJob } from "./maybeCompleteJob.js";
import { notifyUser } from "./notifyUser.js";
import { sendPushToUser } from "./webPush.js";
import { sendExpoPushToUser } from "./expoPush.js";
import { shouldNotify } from "../services/notificationPreferenceService.js";
import { sendWorkerJobStatusEmail } from "./sendMailsUtils.js";

const AUTO_CLOSE_LEASE_MS = 5 * 60_000; // generous vs. realistic processing time; short enough a crash self-heals within a few cron ticks

export type CloseAssignmentTrigger = "cron" | "back_to_back_clock_in";

export type CloseAssignmentResult =
  | { closed: true; assignment: InstanceType<typeof JobAssignment> }
  | { closed: false; reason: "not_claimable" | "invalid_clock_out_time" | "lease_lost" | "job_not_found" };

async function releaseLease(assignmentId: unknown, leaseId: string) {
  await JobAssignment.updateOne(
    { _id: assignmentId, autoCloseLeaseId: leaseId },
    { $set: { autoCloseLeaseAt: null, autoCloseLeaseId: null } }
  );
}

async function notifyManagerOfAutoClose(
  managerId: string,
  managerEmail: string,
  companyId: unknown,
  workerFullname: string,
  job: { _id: string; title: string; date: Date | string; startTime: string; endTime: string },
  overtimeMinutes: number
) {
  const [canEmail, canPush] = await Promise.all([
    shouldNotify(managerId, "shift_auto_closed", "email"),
    shouldNotify(managerId, "shift_auto_closed", "push"),
  ]);

  const title = "Shift auto clocked-out";
  const body = `${workerFullname} never clocked out of ${job.title} — auto-closed and needs review`;
  const tag = `assignment-auto-closed-${job._id}-${managerId}`;

  const results = await Promise.allSettled([
    canEmail
      ? sendWorkerJobStatusEmail({
        type: "missed-clock-out-review",
        adminEmail: managerEmail,
        worker: { fullname: workerFullname },
        job,
        overtimeMinutes,
      })
      : Promise.resolve(),
    canPush
      ? sendPushToUser(managerId, { title, body, tag, url: `/jobs/${job._id}` })
      : Promise.resolve(),
    canPush
      ? sendExpoPushToUser(managerId, { title, body, tag, url: `/jobs/${job._id}` })
      : Promise.resolve(),
    notifyUser({ userId: managerId, companyId, event: "shift_auto_closed", title, body, link: `/jobs/${job._id}` }),
  ]);

  const channels = ["email", "webPush", "expoPush", "inApp"];
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error({ recipientId: managerId, channel: channels[i], event: "shift_auto_closed", error: r.reason });
    }
  });
}

async function notifyWorkerOfAutoClose(
  workerId: string,
  companyId: unknown,
  job: { _id: string; title: string },
  closedAt: Date
) {
  const canPush = await shouldNotify(workerId, "shift_auto_closed", "push");
  const title = "Shift automatically closed";
  const body = `Your shift for ${job.title} was automatically closed at ${closedAt.toLocaleTimeString()}. Contact your manager if the recorded time is incorrect.`;
  const tag = `assignment-auto-closed-${job._id}-${workerId}`;
  const link = `/worker/jobs/${job._id}`;

  const results = await Promise.allSettled([
    canPush ? sendPushToUser(workerId, { title, body, tag, url: link }) : Promise.resolve(),
    canPush ? sendExpoPushToUser(workerId, { title, body, tag, url: link }) : Promise.resolve(),
    notifyUser({ userId: workerId, companyId, event: "shift_auto_closed", title, body, link }),
  ]);

  const channels = ["webPush", "expoPush", "inApp"];
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error({ recipientId: workerId, channel: channels[i], event: "shift_auto_closed", error: r.reason });
    }
  });
}

/**
 * Force-close an assignment the worker never clocked out of.
 *
 * @param effectiveClockOutAt The value to record as checkedOutAt — the
 *   cron's calculated deadline, or shift A's provisional scheduled-end for
 *   a back-to-back discovery. The caller must already have confirmed this
 *   is actually due (now >= effectiveClockOutAt) before calling.
 * @param detectedAt When this was actually discovered/processed — the
 *   cron's own "now" (which can differ from effectiveClockOutAt on a
 *   delayed run) or the back-to-back clock-in attempt's "now". Always
 *   required, never defaulted, so the two are never silently conflated.
 */
export async function closeAssignmentAutomatically(
  assignmentId: unknown,
  effectiveClockOutAt: Date,
  opts: { trigger: CloseAssignmentTrigger; detectedAt: Date }
): Promise<CloseAssignmentResult> {
  const { trigger, detectedAt } = opts;
  const leaseId = new mongoose.Types.ObjectId().toString();

  const claimed = await JobAssignment.findOneAndUpdate(
    {
      _id: assignmentId,
      status: "in-progress",
      checkedOutAt: null,
      $or: [{ autoCloseLeaseAt: null }, { autoCloseLeaseAt: { $lte: new Date(Date.now() - AUTO_CLOSE_LEASE_MS) } }],
    },
    { $set: { autoCloseLeaseAt: new Date(), autoCloseLeaseId: leaseId } },
    { new: true }
  );
  if (!claimed) return { closed: false, reason: "not_claimable" };

  const checkedInAt = new Date(claimed.checkedInAt!);
  if (Number.isNaN(effectiveClockOutAt.getTime()) || effectiveClockOutAt < checkedInAt) {
    await releaseLease(assignmentId, leaseId);
    return { closed: false, reason: "invalid_clock_out_time" };
  }

  const job = await Job.findById(claimed.job).lean();
  if (!job) {
    await releaseLease(assignmentId, leaseId);
    return { closed: false, reason: "job_not_found" };
  }

  const { actualMinutes, overtimeMinutes, approvedMinutes, hadOpenBreak } = computeWorkedMinutes(
    checkedInAt, effectiveClockOutAt, claimed.breaks, job.minutes
  );

  // The one critical transition — conditioned on this process's own lease
  // token, so a process that lost the lease mid-flight (another process
  // reclaimed it after this one's timestamp went stale) can never commit a
  // stale close. Only whichever process still holds the current token wins.
  const updated = await JobAssignment.findOneAndUpdate(
    { _id: assignmentId, autoCloseLeaseId: leaseId, status: "in-progress", checkedOutAt: null },
    {
      $set: {
        checkedOutAt: effectiveClockOutAt,
        completedAt: effectiveClockOutAt,
        status: "completed",
        autoCompleted: true,
        actualMinutes,
        overtimeMinutes,
        approvedMinutes,
        overtimeStatus: "pending",
        clockOutReason: "auto_closed",
      },
    },
    { new: true }
  );
  if (!updated) return { closed: false, reason: "lease_lost" };

  // From here the assignment IS closed. Everything below is best-effort —
  // failure isolation between channels, not guaranteed delivery — and a
  // failure here must never be confused with the close itself failing.
  const sideEffects = await Promise.allSettled([
    logActivity({
      job: updated.job,
      jobDate: job.date,
      assignment: updated._id,
      worker: updated.worker,
      type: "assignment_auto_completed",
      actor: null,
      metadata: { trigger, detectedAt, provisionalClockOutAt: effectiveClockOutAt, workedMinutes: actualMinutes, overtimeMinutes, hadOpenBreak },
    }),
    maybeCompleteJob(updated.job),
    (async () => {
      const manager = await userModel.findOne({ _id: job.createdBy }).select("email");
      const worker = await userModel.findById(updated.worker).select("fullname");
      if (!manager || !worker) return;
      await notifyManagerOfAutoClose(
        manager._id.toString(),
        manager.email,
        updated.company,
        worker.fullname,
        { _id: job._id.toString(), title: job.title, date: job.date, startTime: job.startTime, endTime: job.endTime },
        overtimeMinutes
      );
    })(),
    notifyWorkerOfAutoClose(updated.worker.toString(), updated.company, { _id: job._id.toString(), title: job.title }, effectiveClockOutAt),
  ]);

  const stepNames = ["logActivity", "maybeCompleteJob", "notifyManager", "notifyWorker"];
  sideEffects.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error({ assignmentId, step: stepNames[i], event: "shift_auto_closed", error: r.reason });
    }
  });

  return { closed: true, assignment: updated };
}
