// utils/markMissedShifts.ts
//
// The opposite case from autoCloseAbandonedShifts.ts: a worker who never
// clocked in at all. Nothing else in the system ever moves a never-
// -clocked-in assignment off "accepted", so without this it would just
// silently sit there forever — the job looking like it's still awaiting a
// shift that's long over, no record, no payroll, nobody told.
//
// Runs on the same per-minute cron as the other two shift-health jobs. A
// small grace period after the job's scheduled end avoids flagging a
// worker who's just running a few minutes behind and about to clock in.
// Once flagged, the worker has a fixed 48-hour window (not company-
// configurable, unlike autoClockOutAfterHours — there's no "forgot to
// clock out" buffer concept here, since there's no clock-in to anchor a
// per-job buffer to) to self-report what actually happened via
// requestMissedShiftReview in workerController.ts.
//
// Also broadcasts to every active manager/admin/owner at the company —
// previously this only told the worker, so a no-show was invisible to
// management unless the worker happened to open the app and request a
// review (see requestMissedShiftReview's own, separate manager notice,
// which only fires on THAT self-report path). Same broadcast reasoning
// as the unfilled-shift alerts: whoever's free should see it, not just
// whoever created the job.
import Job from "../models/jobModel.js";
import JobAssignment from "../models/JobAssignment.js";
import userModel from "../models/userModel.js";
import { scheduledEndOf, TZ } from "./dates.js";
import { MANAGEMENT_ROLES } from "./roles.js";
import { sendPushToUser } from "./webPush.js";
import { sendExpoPushToUser } from "./expoPush.js";
import { sendMissedShiftManagerAlert } from "./mailTemplates.js";
import { shouldNotify } from "../services/notificationPreferenceService.js";
import { logActivity } from "./logActivity.js";
import { notifyUser } from "./notifyUser.js";

const GRACE_MINUTES = 30;
export const MISSED_SHIFT_REVIEW_WINDOW_HOURS = 48;

let running = false;

export async function markMissedShifts() {
  if (running) return;
  running = true;

  try {
    const now = new Date();

    const candidates = await JobAssignment.find({
      status: "accepted",
      checkedInAt: null,
      missedShiftDetectedAt: null,
      isDeleted: false,
    });
    if (!candidates.length) return;

    const jobIds = [...new Set(candidates.map(a => a.job.toString()))];

    const jobs = await Job.find({ _id: { $in: jobIds }, isDeleted: false, isTemplate: false, status: "published" }).lean();
    const jobById = new Map(jobs.map(job => [job._id.toString(), job]));

    for (const assignment of candidates) {
      const job = jobById.get(assignment.job.toString());
      if (!job) continue;

      const scheduledEnd = scheduledEndOf(job, TZ);
      const flagAt = new Date(scheduledEnd.getTime() + GRACE_MINUTES * 60 * 1000);
      if (now < flagAt) continue;

      try {
        assignment.missedShiftDetectedAt = now;
        assignment.missedShiftReviewDeadline = new Date(
          scheduledEnd.getTime() + MISSED_SHIFT_REVIEW_WINDOW_HOURS * 60 * 60 * 1000
        );
        await assignment.save();

        await logActivity({
          job: assignment.job,
          jobDate: job.date,
          assignment: assignment._id,
          worker: assignment.worker,
          type: "assignment_missed_shift_detected",
          actor: null,
          metadata: { reviewDeadline: assignment.missedShiftReviewDeadline },
        });

        const worker = await userModel.findById(assignment.worker).select("fullname");
        if (!worker) continue;

        const canPush = await shouldNotify(worker._id.toString(), "missed_shift_detected", "push");
        const title = "Shift missed";
        const body = `You didn't clock in for ${job.title}. Request a review before it closes.`;
        const link = `/worker/jobs/${job._id}`;

        await Promise.all([
          canPush
            ? sendPushToUser(worker._id.toString(), { title, body, tag: `missed-shift-${assignment._id}`, url: link })
            : Promise.resolve(),
          canPush
            ? sendExpoPushToUser(worker._id.toString(), { title, body, tag: `missed-shift-${assignment._id}`, url: link })
            : Promise.resolve(),
          notifyUser({
            userId: worker._id.toString(),
            companyId: assignment.company,
            event: "missed_shift_detected",
            title,
            body,
            link,
          }),
        ]);

        const managers = await userModel
          .find({ company: assignment.company, role: { $in: MANAGEMENT_ROLES }, isActive: true })
          .select("fullname email");

        if (managers.length) {
          const managerTitle = "Shift missed";
          const managerBody = `${worker.fullname} never clocked in for ${job.title}.`;
          const managerLink = `/jobs/${job._id}`;

          await Promise.all(
            managers.map(async manager => {
              const managerId = manager._id.toString();
              const [canEmail, canManagerPush] = await Promise.all([
                shouldNotify(managerId, "missed_shift_detected", "email"),
                shouldNotify(managerId, "missed_shift_detected", "push"),
              ]);

              await Promise.all([
                canEmail
                  ? sendMissedShiftManagerAlert({
                      manager: { email: manager.email, fullname: manager.fullname },
                      worker: { fullname: worker.fullname },
                      job: {
                        _id: job._id.toString(),
                        title: job.title,
                        location: job.location,
                        address: job.address,
                        date: job.date,
                        startTime: job.startTime,
                        endTime: job.endTime,
                        minutes: job.minutes,
                      },
                      company: job.company,
                    })
                  : Promise.resolve(),
                canManagerPush
                  ? sendPushToUser(managerId, { title: managerTitle, body: managerBody, tag: `missed-shift-manager-${assignment._id}`, url: managerLink })
                  : Promise.resolve(),
                canManagerPush
                  ? sendExpoPushToUser(managerId, { title: managerTitle, body: managerBody, tag: `missed-shift-manager-${assignment._id}`, url: managerLink })
                  : Promise.resolve(),
                notifyUser({
                  userId: managerId,
                  companyId: assignment.company,
                  event: "missed_shift_detected",
                  title: managerTitle,
                  body: managerBody,
                  link: managerLink,
                }),
              ]);
            })
          );
        }
      } catch (err) {
        console.error(`Failed to flag missed shift for assignment ${assignment._id}:`, err);
      }
    }
  } finally {
    running = false;
  }
}
