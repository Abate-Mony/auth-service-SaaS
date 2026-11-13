// A worker who's accepted a shift gets one more heads-up the evening
// before it, in addition to the hour-before reminder in
// sendUpcomingShiftReminders.ts — enough notice to sort childcare,
// transport, or kit, which an hour's warning doesn't give.
//
// "Evening before" is a per-company local-time concept (6pm in London
// means something different from 6pm in New York), so this checks each
// job's own company timezone rather than a single global cutoff. Runs on
// the same per-minute cron as the other shift-health jobs: once a
// company's local clock passes 6pm, every one of its accepted assignments
// for tomorrow becomes due, and dayBeforeReminderSentAt stops it being
// sent twice (including if the cron is briefly down and catches up after
// 6pm has already passed).
import dayjs from "./dayjsSetup.js";
import Job from "../models/jobModel.js";
import JobAssignment from "../models/JobAssignment.js";
import Company from "../models/company.js";
import { TZ } from "./dates.js";
import { sendDayBeforeShiftReminder } from "./mailTemplates.js";
import { sendPushToUser } from "./webPush.js";
import { sendExpoPushToUser } from "./expoPush.js";

const REMINDER_LOCAL_HOUR = 18; // 6pm

let running = false;

export async function sendDayBeforeShiftReminders() {
  if (running) return;
  running = true;

  try {
    const now = new Date();

    // Cheap, indexed pre-filter — "tomorrow" in any real-world timezone
    // falls within a couple of days of now in UTC terms.
    const jobs = await Job.find({
      isDeleted: false,
      status: "published",
      isTemplate: false,
      date: {
        $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        $lte: new Date(now.getTime() + 48 * 60 * 60 * 1000),
      },
    }).lean();
    if (!jobs.length) return;

    const companyIds = [...new Set(jobs.map(job => job.company.toString()))];
    const companies = await Company.find({ _id: { $in: companyIds } }).select("timezone").lean();
    const tzByCompany = new Map(companies.map(c => [c._id.toString(), c.timezone || TZ]));

    // Due only once it's actually "tomorrow, 6pm or later" in that
    // specific company's own timezone — a company further west might not
    // be there yet; one further east might already be past it.
    const dueJobs = jobs.filter(job => {
      const tz = tzByCompany.get(job.company.toString()) ?? TZ;
      const nowLocal = dayjs(now).tz(tz);
      if (nowLocal.hour() < REMINDER_LOCAL_HOUR) return false;
      const jobDayKey = dayjs.utc(job.date).format("YYYY-MM-DD");
      const tomorrowKey = nowLocal.add(1, "day").format("YYYY-MM-DD");
      return jobDayKey === tomorrowKey;
    });
    if (!dueJobs.length) return;

    const jobById = new Map(dueJobs.map(job => [job._id.toString(), job]));

    const assignments = await JobAssignment.find({
      job: { $in: dueJobs.map(job => job._id) },
      status: "accepted",
      dayBeforeReminderSentAt: null,
    }).populate("worker", "fullname email");

    for (const assignment of assignments) {
      const job = jobById.get(assignment.job.toString());
      const worker = assignment.worker as any;
      if (!job || !worker?.email) continue;

      try {
        await Promise.all([
          sendDayBeforeShiftReminder({
            worker: { email: worker.email, fullname: worker.fullname },
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
          }),
          sendPushToUser(worker._id.toString(), {
            title: "Shift tomorrow",
            body: `${job.title} at ${job.startTime} — ${job.location}`,
            tag: `shift-day-before-${job._id}`,
          }),
          sendExpoPushToUser(worker._id.toString(), {
            title: "Shift tomorrow",
            body: `${job.title} at ${job.startTime} — ${job.location}`,
            tag: `shift-day-before-${job._id}`,
            url: `/worker/jobs/${job._id}`,
          }),
        ]);
        assignment.dayBeforeReminderSentAt = new Date();
        await assignment.save();
      } catch (err) {
        console.error(`Failed to send day-before shift reminder for assignment ${assignment._id}:`, err);
        // dayBeforeReminderSentAt stays unset so the next tick retries this one
      }
    }
  } finally {
    running = false;
  }
}
