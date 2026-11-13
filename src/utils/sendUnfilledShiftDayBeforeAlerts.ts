// A published shift tomorrow that nobody has actually accepted yet — still
// pending invites, or nobody assigned at all — is a real risk nobody's
// been proactively told about until now; a manager would otherwise only
// find out by noticing it on the Jobs list. Same per-company-local-time
// trigger as sendDayBeforeShiftReminders.ts (6pm in the company's own
// timezone), but checked at the job level against zero accepted workers,
// and broadcast to every active manager/admin/owner rather than a single
// worker — same "whoever's free should see it" reasoning workerController.ts
// already uses for a declined/cancelled shift needing covering.
import dayjs from "./dayjsSetup.js";
import Job from "../models/jobModel.js";
import JobAssignment from "../models/JobAssignment.js";
import Company from "../models/company.js";
import userModel from "../models/userModel.js";
import { TZ } from "./dates.js";
import { MANAGEMENT_ROLES } from "./roles.js";
import { sendUnfilledShiftDayBeforeAlert } from "./mailTemplates.js";
import { sendPushToUser } from "./webPush.js";
import { sendExpoPushToUser } from "./expoPush.js";
import { shouldNotify } from "../services/notificationPreferenceService.js";
import { notifyUser } from "./notifyUser.js";

const ALERT_LOCAL_HOUR = 18; // 6pm

let running = false;

export async function sendUnfilledShiftDayBeforeAlerts() {
  if (running) return;
  running = true;

  try {
    const now = new Date();

    const jobs = await Job.find({
      isDeleted: false,
      status: "published",
      isTemplate: false,
      unfilledDayBeforeAlertSentAt: null,
      date: {
        $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        $lte: new Date(now.getTime() + 48 * 60 * 60 * 1000),
      },
    }).lean();
    if (!jobs.length) return;

    const companyIds = [...new Set(jobs.map(job => job.company.toString()))];
    const companies = await Company.find({ _id: { $in: companyIds } }).select("timezone").lean();
    const tzByCompany = new Map(companies.map(c => [c._id.toString(), c.timezone || TZ]));

    const dueJobs = jobs.filter(job => {
      const tz = tzByCompany.get(job.company.toString()) ?? TZ;
      const nowLocal = dayjs(now).tz(tz);
      if (nowLocal.hour() < ALERT_LOCAL_HOUR) return false;
      const jobDayKey = dayjs.utc(job.date).format("YYYY-MM-DD");
      const tomorrowKey = nowLocal.add(1, "day").format("YYYY-MM-DD");
      return jobDayKey === tomorrowKey;
    });
    if (!dueJobs.length) return;

    const acceptedJobIds = new Set(
      (
        await JobAssignment.distinct("job", {
          job: { $in: dueJobs.map(job => job._id) },
          status: "accepted",
          isDeleted: false,
        })
      ).map(id => id.toString())
    );
    const unfilledJobs = dueJobs.filter(job => !acceptedJobIds.has(job._id.toString()));
    if (!unfilledJobs.length) return;

    for (const job of unfilledJobs) {
      try {
        const managers = await userModel
          .find({ company: job.company, role: { $in: MANAGEMENT_ROLES }, isActive: true })
          .select("fullname email");

        if (managers.length) {
          const title = "Shift unfilled";
          const body = `${job.title} tomorrow at ${job.startTime} has nobody confirmed yet.`;
          const link = `/jobs/${job._id}`;

          await Promise.all(
            managers.map(async manager => {
              const managerId = manager._id.toString();
              const [canEmail, canPush] = await Promise.all([
                shouldNotify(managerId, "shift_unfilled", "email"),
                shouldNotify(managerId, "shift_unfilled", "push"),
              ]);

              await Promise.all([
                canEmail
                  ? sendUnfilledShiftDayBeforeAlert({
                      manager: { email: manager.email, fullname: manager.fullname },
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
                canPush
                  ? sendPushToUser(managerId, { title, body, tag: `shift-unfilled-day-before-${job._id}`, url: link })
                  : Promise.resolve(),
                canPush
                  ? sendExpoPushToUser(managerId, { title, body, tag: `shift-unfilled-day-before-${job._id}`, url: link })
                  : Promise.resolve(),
                notifyUser({ userId: managerId, companyId: job.company, event: "shift_unfilled", title, body, link }),
              ]);
            })
          );
        }

        await Job.updateOne({ _id: job._id }, { unfilledDayBeforeAlertSentAt: new Date() });
      } catch (err) {
        console.error(`Failed to send unfilled-shift day-before alert for job ${job._id}:`, err);
        // unfilledDayBeforeAlertSentAt stays unset so the next tick retries this one
      }
    }
  } finally {
    running = false;
  }
}
