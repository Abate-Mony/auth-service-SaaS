import { StatusCodes } from "http-status-codes";
import { getReqUser, MiddlewareFn } from "../interfaces/expresstype.js";
import userModel from "../models/userModel.js";
import jobModel from "../models/jobModel.js";
import JobAssignment from "../models/JobAssignment.js";
import ActivityLog from "../models/ActivityLog.js";
import Company from "../models/company.js";

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}
function startOfWeek(d: Date) {
  const x = startOfDay(d);
  const day = x.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  x.setDate(x.getDate() + diff);
  return x;
}
function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

// Worked minutes, net of breaks — JobAssignment only exposes this as a
// virtual (workedMinutes), which a Mongo aggregation pipeline can't see.
// The previous version of this file summed a field called "hoursWorked"
// that was never actually on the schema, so every hours total here always
// came back 0 — computed in JS instead, same as the rest of this codebase
// already does for worker stats and timesheets.
function workedMinutesOf(a: {
  checkedInAt?: Date | null;
  checkedOutAt?: Date | null;
  breaks?: { startedAt?: Date | null; endedAt?: Date | null }[];
}): number {
  if (!a.checkedInAt || !a.checkedOutAt) return 0;
  const gross = Math.round((a.checkedOutAt.getTime() - a.checkedInAt.getTime()) / 60_000);
  const breakMins = (a.breaks ?? []).reduce((sum, b) => {
    if (!b.startedAt || !b.endedAt) return sum;
    return sum + Math.round((b.endedAt.getTime() - b.startedAt.getTime()) / 60_000);
  }, 0);
  return Math.max(0, gross - breakMins);
}

export const getDashboardStats: MiddlewareFn = async (req, res) => {
  const currentUser = getReqUser(req);
  const companyId = currentUser.company_id;
  // Job.company is schema-typed String (a pre-existing quirk elsewhere in
  // this codebase), unlike User/JobAssignment's ObjectId — cast separately.
  const companyIdStr = companyId.toString();

  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  const yesterdayStart = startOfDay(new Date(now.getTime() - 86400000));
  const yesterdayEnd = endOfDay(new Date(now.getTime() - 86400000));
  const weekStart = startOfWeek(now);
  const monthStart = startOfMonth(now);
  const lastMonthStart = new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1);
  // Bounds "recent activity" to jobs from the last 30 days — otherwise
  // scoping ActivityLog (which has no company field of its own) to this
  // company would mean pulling every job id it's ever had.
  const activityWindowStart = new Date(now.getTime() - 30 * 86400000);

  const [
    todaysJobsCount,
    todaysJobsInProgress,
    yesterdaysJobsCount,
    totalWorkersCount,
    workersActiveNow,
    weekAssignments,
    jobsCompletedThisMonth,
    jobsCompletedLastMonth,
    workingNow,
    todaysJobsList,
    recentActivityJobs,
    unstaffedJob,
    companySettings,
  ] = await Promise.all([
    jobModel.countDocuments({ company: companyIdStr, date: { $gte: todayStart, $lte: todayEnd } }),

    jobModel.countDocuments({
      company: companyIdStr,
      date: { $gte: todayStart, $lte: todayEnd },
      status: "published",
    }),

    jobModel.countDocuments({ company: companyIdStr, date: { $gte: yesterdayStart, $lte: yesterdayEnd } }),

    userModel.countDocuments({ role: "worker", company: companyId }),

    JobAssignment.countDocuments({
      company: companyId,
      status: "in-progress",
      checkedInAt: { $ne: null },
      checkedOutAt: null,
    }),

    JobAssignment.find({
      company: companyId,
      checkedInAt: { $gte: weekStart, $ne: null },
      checkedOutAt: { $ne: null },
    })
      .select("checkedInAt checkedOutAt breaks")
      .lean(),

    jobModel.countDocuments({ company: companyIdStr, status: "completed", updatedAt: { $gte: monthStart } }),

    jobModel.countDocuments({
      company: companyIdStr,
      status: "completed",
      updatedAt: { $gte: lastMonthStart, $lt: monthStart },
    }),

    JobAssignment.find({
      company: companyId,
      status: "in-progress",
      checkedInAt: { $ne: null },
      checkedOutAt: null,
    })
      .populate("worker", "fullname")
      .populate("job", "title location startTime endTime")
      .sort({ checkedInAt: -1 })
      .limit(5),

    jobModel
      .find({ company: companyIdStr, date: { $gte: todayStart, $lte: todayEnd } })
      .sort({ startTime: 1 })
      .limit(10),

    jobModel
      .find({ company: companyIdStr, date: { $gte: activityWindowStart } })
      .select("_id")
      .lean(),

    jobModel.findOne({ company: companyIdStr, status: "published" }).then(async job => {
      if (!job) return null;
      const assignedCount = await JobAssignment.countDocuments({
        job: job._id,
        status: { $in: ["accepted", "in-progress", "completed"] },
      });
      return assignedCount === 0 ? job : null;
    }),

    Company.findById(companyId).select("weeklyHoursTarget").lean(),
  ]);

  // ActivityLog has no company field of its own — scoped here through the
  // company's own recent job ids resolved above, rather than the previous
  // {job: {$exists: true}}, which returned every company's activity mixed
  // together.
  const recentActivity = await ActivityLog.find({
    job: { $in: recentActivityJobs.map(j => j._id) },
  })
    .populate("actor", "fullname")
    .populate("job", "title")
    .sort({ createdAt: -1 })
    .limit(10);

  let hoursThisWeekMinutes = 0;
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const minutesByDay: Record<string, number> = { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0, Sun: 0 };
  for (const a of weekAssignments) {
    const minutes = workedMinutesOf(a);
    hoursThisWeekMinutes += minutes;
    if (a.checkedInAt) minutesByDay[DAY_NAMES[a.checkedInAt.getDay()]] += minutes;
  }
  const hoursByDay = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(day => ({
    day,
    hours: Math.round(minutesByDay[day] / 60),
  }));

  const completedDelta =
    jobsCompletedLastMonth === 0
      ? null
      : Math.round(
          ((jobsCompletedThisMonth - jobsCompletedLastMonth) / jobsCompletedLastMonth) * 100
        );

  res.status(StatusCodes.OK).json({
    stats: {
      todaysJobs: {
        count: todaysJobsCount,
        inProgress: todaysJobsInProgress,
        deltaFromYesterday: todaysJobsCount - yesterdaysJobsCount,
      },
      workersActive: {
        active: workersActiveNow,
        total: totalWorkersCount,
      },
      hoursThisWeek: {
        total: Math.round(hoursThisWeekMinutes / 60),
        // weeklyHoursTarget is a company-wide setting; falls back to the old
        // "80 hours per worker" guess when a company hasn't configured one.
        target: companySettings?.weeklyHoursTarget || totalWorkersCount * 80,
      },
      jobsCompleted: {
        thisMonth: jobsCompletedThisMonth,
        deltaPercent: completedDelta,
      },
    },
    hoursByDay,
    workingNow: workingNow.map((a: any) => ({
      assignmentId: a._id,
      worker: a.worker,
      job: a.job,
      checkedInAt: a.checkedInAt,
    })),
    todaysJobs: todaysJobsList,
    recentActivity,
    attentionNeeded: unstaffedJob ? { jobId: unstaffedJob._id, title: unstaffedJob.title } : null,
  });
};
