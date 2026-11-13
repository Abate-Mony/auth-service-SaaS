// A plain "FYI, this job starts in about an hour" to the job's own
// creator — distinct from sendUnfilledShiftUrgentAlerts.ts, which only
// fires when a shift has zero accepted workers and broadcasts to every
// manager. This one fires for every published job regardless of staffing,
// and goes only to createdBy, matching the "FYI to the job's owner"
// pattern already used for overtime-needs-review and
// missed-shift-review-requested, rather than the "needs covering, tell
// everyone" broadcast pattern.
import Job from "../models/jobModel.js";
import userModel from "../models/userModel.js";
import { scheduledStartOf } from "./dates.js";
import { sendJobStartingSoonAlert } from "./mailTemplates.js";
import { sendPushToUser } from "./webPush.js";
import { sendExpoPushToUser } from "./expoPush.js";
import { shouldNotify } from "../services/notificationPreferenceService.js";
import { notifyUser } from "./notifyUser.js";

const ALERT_WINDOW_MINUTES = 60;

let running = false;

export async function sendJobStartingSoonCreatorAlerts() {
  if (running) return;
  running = true;

  try {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + ALERT_WINDOW_MINUTES * 60 * 1000);

    const jobs = await Job.find({
      isDeleted: false,
      status: "published",
      isTemplate: false,
      creatorStartingSoonAlertSentAt: null,
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

    for (const job of dueJobs) {
      try {
        if (job.createdBy) {
          const creator = await userModel.findById(job.createdBy).select("fullname email");
          if (creator?.email) {
            const creatorId = creator._id.toString();
            const [canEmail, canPush] = await Promise.all([
              shouldNotify(creatorId, "job_starting_soon", "email"),
              shouldNotify(creatorId, "job_starting_soon", "push"),
            ]);

            const title = "Job starting soon";
            const body = `${job.title} starts at ${job.startTime} — ${job.location}`;
            const link = `/jobs/${job._id}`;

            await Promise.all([
              canEmail
                ? sendJobStartingSoonAlert({
                    manager: { email: creator.email, fullname: creator.fullname },
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
                ? sendPushToUser(creatorId, { title, body, tag: `job-starting-soon-${job._id}`, url: link })
                : Promise.resolve(),
              canPush
                ? sendExpoPushToUser(creatorId, { title, body, tag: `job-starting-soon-${job._id}`, url: link })
                : Promise.resolve(),
              notifyUser({ userId: creatorId, companyId: job.company, event: "job_starting_soon", title, body, link }),
            ]);
          }
        }

        await Job.updateOne({ _id: job._id }, { creatorStartingSoonAlertSentAt: new Date() });
      } catch (err) {
        console.error(`Failed to send job-starting-soon creator alert for job ${job._id}:`, err);
        // creatorStartingSoonAlertSentAt stays unset so the next tick retries this one
      }
    }
  } finally {
    running = false;
  }
}
