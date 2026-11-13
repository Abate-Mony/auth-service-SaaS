// The urgent sibling of sendUnfilledShiftDayBeforeAlerts.ts — same "zero
// accepted workers" condition, checked again an hour before the shift
// starts (same window sendUpcomingShiftReminders.ts uses for the worker's
// own reminder). Independent of whether the day-before alert fired: if the
// shift got filled since then, it's simply not in the unfilled set here
// and nothing goes out.
import Job from "../models/jobModel.js";
import JobAssignment from "../models/JobAssignment.js";
import userModel from "../models/userModel.js";
import { scheduledStartOf } from "./dates.js";
import { MANAGEMENT_ROLES } from "./roles.js";
import { sendUnfilledShiftUrgentAlert } from "./mailTemplates.js";
import { sendPushToUser } from "./webPush.js";
import { sendExpoPushToUser } from "./expoPush.js";
import { shouldNotify } from "../services/notificationPreferenceService.js";
import { notifyUser } from "./notifyUser.js";

const ALERT_WINDOW_MINUTES = 60;

let running = false;

export async function sendUnfilledShiftUrgentAlerts() {
  if (running) return;
  running = true;

  try {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + ALERT_WINDOW_MINUTES * 60 * 1000);

    const jobs = await Job.find({
      isDeleted: false,
      status: "published",
      isTemplate: false,
      unfilledUrgentAlertSentAt: null,
      date: {
        $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        $lte: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      },
    }).lean();
    if (!jobs.length) return;

    const dueJobs = jobs.filter(job => {
      const start = scheduledStartOf(job);
      return start > now && start <= windowEnd;
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
          const title = "Urgent: shift unfilled";
          const body = `${job.title} starts at ${job.startTime} with nobody confirmed. Fill it now.`;
          const link = `/jobs/${job._id}`;

          await Promise.all(
            managers.map(async manager => {
              const managerId = manager._id.toString();
              const [canEmail, canPush] = await Promise.all([
                shouldNotify(managerId, "shift_unfilled_urgent", "email"),
                shouldNotify(managerId, "shift_unfilled_urgent", "push"),
              ]);

              await Promise.all([
                canEmail
                  ? sendUnfilledShiftUrgentAlert({
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
                  ? sendPushToUser(managerId, { title, body, tag: `shift-unfilled-urgent-${job._id}`, url: link })
                  : Promise.resolve(),
                canPush
                  ? sendExpoPushToUser(managerId, { title, body, tag: `shift-unfilled-urgent-${job._id}`, url: link })
                  : Promise.resolve(),
                notifyUser({ userId: managerId, companyId: job.company, event: "shift_unfilled_urgent", title, body, link }),
              ]);
            })
          );
        }

        await Job.updateOne({ _id: job._id }, { unfilledUrgentAlertSentAt: new Date() });
      } catch (err) {
        console.error(`Failed to send unfilled-shift urgent alert for job ${job._id}:`, err);
        // unfilledUrgentAlertSentAt stays unset so the next tick retries this one
      }
    }
  } finally {
    running = false;
  }
}
