// A worker who forgets to tap "clock out" leaves an assignment stuck
// "in-progress" forever, and every minute it stays open is unbilled risk for
// the company. This runs on the same per-minute cron as the shift reminder:
// once a shift has been running for company.autoClockOutAfterHours past its
// scheduled end with no clock-out, force-close it — but cap the pay-affecting
// approvedMinutes at the scheduled amount and flag it "pending" so a manager
// has to actively approve the extra time before payroll ever sees it.
import Company from "../models/company.js";
import Job from "../models/jobModel.js";
import JobAssignment from "../models/JobAssignment.js";
import userModel from "../models/userModel.js";
import { scheduledEndOf, TZ } from "./dates.js";
import { sendWorkerJobStatusEmail } from "./sendMailsUtils.js";
import { sendPushToUser } from "./webPush.js";
import { shouldNotify } from "../services/notificationPreferenceService.js";
import { logActivity } from "./logActivity.js";

let running = false;

async function notifyManagerOfAutoClose(
  managerId: string,
  managerEmail: string,
  workerFullname: string,
  job: { _id: string; title: string; date: Date | string; startTime: string; endTime: string },
  overtimeMinutes: number
) {
  const [canEmail, canPush] = await Promise.all([
    shouldNotify(managerId, "worker_checked_out", "email"),
    shouldNotify(managerId, "worker_checked_out", "push"),
  ]);

  await Promise.all([
    canEmail
      ? sendWorkerJobStatusEmail({
        type: "overtime-review",
        adminEmail: managerEmail,
        worker: { fullname: workerFullname },
        job,
        overtimeMinutes,
      })
      : Promise.resolve(),
    canPush
      ? sendPushToUser(managerId, {
        title: "Shift auto clocked-out",
        body: `${workerFullname} never clocked out of ${job.title} — auto-closed and needs review`,
        tag: `assignment-auto-closed-${job._id}`,
        url: `/jobs/${job._id}`,
      })
      : Promise.resolve(),
  ]);
}

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
    });
    if (!openAssignments.length) return;

    const jobIds = [...new Set(openAssignments.map(a => a.job.toString()))];
    const companyIds = [...new Set(openAssignments.map(a => a.company.toString()))];

    const [jobs, companies] = await Promise.all([
      Job.find({ _id: { $in: jobIds } }).lean(),
      Company.find({ _id: { $in: companyIds } })
        .select("timezone autoClockOutEnabled autoClockOutAfterHours lateClockOutThresholdMinutes")
        .lean(),
    ]);

    const jobById = new Map(jobs.map(job => [job._id.toString(), job]));
    const companyById = new Map(companies.map(company => [company._id.toString(), company]));

    for (const assignment of openAssignments) {
      const job = jobById.get(assignment.job.toString());
      if (!job || !assignment.checkedInAt) continue;

      const company = companyById.get(assignment.company.toString());
      if (company?.autoClockOutEnabled === false) continue;

      const tz = company?.timezone ?? TZ;
      const scheduledEnd = scheduledEndOf(job, tz);
      const closeAfterHours = company?.autoClockOutAfterHours ?? 2;
      const closeAt = new Date(scheduledEnd.getTime() + closeAfterHours * 60 * 60 * 1000);
      if (now < closeAt) continue;

      try {
        const grossMinutes = Math.round((now.getTime() - new Date(assignment.checkedInAt).getTime()) / 60_000);
        const breakMinutes = [...(assignment.breaks ?? [])].reduce(
          (sum, b) =>
            b.endedAt
              ? sum + Math.round((new Date(b.endedAt).getTime() - new Date(b.startedAt!).getTime()) / 60_000)
              : sum,
          0
        );
        const workedMinutes = Math.max(0, grossMinutes - breakMinutes);
        const overtimeMinutes = Math.max(0, workedMinutes - job.minutes);

        assignment.checkedOutAt = now;
        assignment.completedAt = now;
        assignment.status = "completed";
        assignment.autoCompleted = true;
        assignment.actualMinutes = workedMinutes;
        assignment.overtimeMinutes = overtimeMinutes;
        // Nobody confirmed any of this time — cap what payroll sees at the
        // scheduled amount and let a manager review the rest.
        assignment.approvedMinutes = Math.max(0, workedMinutes - overtimeMinutes);
        assignment.overtimeStatus = "pending";
        assignment.clockOutReason = "auto_closed";

        await assignment.save();

        await logActivity({
          job: assignment.job,
          jobDate: job.date,
          assignment: assignment._id,
          worker: assignment.worker,
          type: "assignment_auto_completed",
          actor: null,
          metadata: { workedMinutes, overtimeMinutes, closeAfterHours },
        });

        const manager = await userModel.findOne({ _id: job.createdBy }).select("email");
        const worker = await userModel.findById(assignment.worker).select("fullname");
        if (manager && worker) {
          await notifyManagerOfAutoClose(
            manager._id.toString(),
            manager.email,
            worker.fullname,
            {
              _id: job._id.toString(),
              title: job.title,
              date: job.date,
              startTime: job.startTime,
              endTime: job.endTime,
            },
            overtimeMinutes
          );
        }
      } catch (err) {
        console.error(`Failed to auto-close assignment ${assignment._id}:`, err);
      }
    }
  } finally {
    running = false;
  }
}
