// A worker who forgets to tap "clock out" leaves an assignment stuck
// "in-progress" forever, and every minute it stays open is unbilled risk for
// the company. This runs on the same per-minute cron as the shift reminder:
// once a shift has been running for its own scheduled duration plus
// company.autoClockOutAfterHours past the worker's ACTUAL clock-in — not the
// job's scheduled end — it's due for force-closing. Basing this on clock-in
// rather than scheduled end means a worker who clocks in late still gets
// their full expected shift length before being auto-closed, instead of
// getting force-closed almost immediately because the scheduled end had
// already passed by the time they started.
//
// The actual close (lease-protected against concurrent cron instances,
// capped approval, open-break handling, notifications) lives in
// closeAssignmentAutomatically.ts, shared with the back-to-back-shift
// discovery path in workerController.ts — this file's only job is finding
// which assignments are due and calling it with the right deadline.
import Company from "../models/company.js";
import Job from "../models/jobModel.js";
import JobAssignment from "../models/JobAssignment.js";
import { closeAssignmentAutomatically } from "./closeAssignmentAutomatically.js";

let running = false;

export async function autoCloseAbandonedShifts() {
  if (running) return;
  running = true;

  try {
    const now = new Date();

    const openAssignments = await JobAssignment.find({
      status: "in-progress",
      isDeleted: false,
      checkedInAt: { $ne: null },
      checkedOutAt: null,
    }).select("job company checkedInAt");
    if (!openAssignments.length) return;

    const jobIds = [...new Set(openAssignments.map(a => a.job.toString()))];
    const companyIds = [...new Set(openAssignments.map(a => a.company.toString()))];

    const [jobs, companies] = await Promise.all([
      Job.find({ _id: { $in: jobIds } }).select("minutes").lean(),
      Company.find({ _id: { $in: companyIds } }).select("autoClockOutEnabled autoClockOutAfterHours").lean(),
    ]);

    const jobById = new Map(jobs.map(job => [job._id.toString(), job]));
    const companyById = new Map(companies.map(company => [company._id.toString(), company]));

    for (const assignment of openAssignments) {
      const job = jobById.get(assignment.job.toString());
      if (!job || !assignment.checkedInAt) continue;

      const company = companyById.get(assignment.company.toString());
      if (company?.autoClockOutEnabled === false) continue;

      const closeAfterHours = company?.autoClockOutAfterHours ?? 2;
      const closeAt = new Date(
        new Date(assignment.checkedInAt).getTime() + job.minutes * 60 * 1000 + closeAfterHours * 60 * 60 * 1000
      );
      if (now < closeAt) continue;

      try {
        // Use the calculated deadline as the recorded clock-out, not
        // whenever this cron tick happens to run — a delayed/restarted
        // cron must never inflate recorded time. detectedAt is separately
        // "now", since a late cron run means these can genuinely differ.
        await closeAssignmentAutomatically(assignment._id, closeAt, { trigger: "cron", detectedAt: now });
      } catch (err) {
        console.error(`Failed to auto-close assignment ${assignment._id}:`, err);
      }
    }
  } finally {
    running = false;
  }
}
