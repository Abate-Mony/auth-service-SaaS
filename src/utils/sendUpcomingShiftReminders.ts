import Job from "../models/jobModel.js";
import JobAssignment from "../models/JobAssignment.js";
import { scheduledStartOf } from "./dates.js";
import { sendShiftReminder } from "./mailTemplates.js";

const REMINDER_WINDOW_MINUTES = 30;

// Guards against overlapping runs if a previous tick is still sending mail
// when the next one fires (cron runs this every minute).
let running = false;

export async function sendUpcomingShiftReminders() {
  if (running) return;
  running = true;

  try {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_MINUTES * 60 * 1000);

    // Cheap, indexed pre-filter — startTime/timezone math can only ever push
    // a shift's actual start into the day before or after its stored date.
    const jobs = await Job.find({
      isDeleted: false,
      status: "published",
      date: {
        $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        $lte: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      },
    }).lean();

    const dueJobs = jobs.filter(job => {
      const start = scheduledStartOf(job);
      return start > now && start <= windowEnd;
    });
    if (!dueJobs.length) return;

    const jobById = new Map(dueJobs.map(job => [job._id.toString(), job]));

    const assignments = await JobAssignment.find({
      job: { $in: dueJobs.map(job => job._id) },
      status: "accepted",
      checkedInAt: null,
      reminderSentAt: null,
    }).populate("worker", "fullname email");

    for (const assignment of assignments) {
      const job = jobById.get(assignment.job.toString());
      const worker = assignment.worker as any;
      if (!job || !worker?.email) continue;

      try {
        await sendShiftReminder({
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
        });
        assignment.reminderSentAt = new Date();
        await assignment.save();
      } catch (err) {
        console.error(`Failed to send shift reminder for assignment ${assignment._id}:`, err);
        // reminderSentAt stays unset so the next tick retries this one
      }
    }
  } finally {
    running = false;
  }
}
