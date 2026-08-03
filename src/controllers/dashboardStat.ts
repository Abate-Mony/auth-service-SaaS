import { StatusCodes } from "http-status-codes";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import userModel from "../models/userModel.js";
import jobModel from "../models/jobModel.js";
import JobAssignment from "../models/JobAssignment.js";
import ActivityLog from "../models/ActivityLog.js";

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

export const getDashboardStats: MiddlewareFn = async (req, res) => {
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  const yesterdayStart = startOfDay(new Date(now.getTime() - 86400000));
  const yesterdayEnd = endOfDay(new Date(now.getTime() - 86400000));
  const weekStart = startOfWeek(now);
  const monthStart = startOfMonth(now);
  const lastMonthStart = new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1);

  const [
    todaysJobsCount,
    todaysJobsInProgress,
    yesterdaysJobsCount,
    totalWorkersCount,
    workersActiveNow,
    hoursThisWeekAgg,
    hoursByDayAgg,
    jobsCompletedThisMonth,
    jobsCompletedLastMonth,
    workingNow,
    todaysJobsList,
    recentActivity,
    unstaffedJob,
  ] = await Promise.all([
    jobModel.countDocuments({ date: { $gte: todayStart, $lte: todayEnd } }),

    jobModel.countDocuments({
      date: { $gte: todayStart, $lte: todayEnd },
      status: "published",
    }),

    jobModel.countDocuments({ date: { $gte: yesterdayStart, $lte: yesterdayEnd } }),

    userModel.countDocuments({ role: "worker" }),

    JobAssignment.countDocuments({
      status: "in-progress",
      checkedInAt: { $ne: null },
      checkedOutAt: null,
    }),

    JobAssignment.aggregate([
      { $match: { checkedInAt: { $gte: weekStart } } },
      { $group: { _id: null, total: { $sum: "$hoursWorked" } } },
    ]),

    JobAssignment.aggregate([
      { $match: { checkedInAt: { $gte: weekStart } } },
      { $group: { _id: { $dayOfWeek: "$checkedInAt" }, total: { $sum: "$hoursWorked" } } },
    ]),

    jobModel.countDocuments({ status: "completed", updatedAt: { $gte: monthStart } }),

    jobModel.countDocuments({
      status: "completed",
      updatedAt: { $gte: lastMonthStart, $lt: monthStart },
    }),

    JobAssignment.find({
      status: "in-progress",
      checkedInAt: { $ne: null },
      checkedOutAt: null,
    })
      .populate("worker", "fullname")
      .populate("job", "title location startTime endTime")
      .sort({ checkedInAt: -1 })
      .limit(5),

    jobModel
      .find({ date: { $gte: todayStart, $lte: todayEnd } })
      .sort({ startTime: 1 })
      .limit(10),

    ActivityLog.find({ job: { $exists: true } })
      .populate("actor", "fullname")
      .populate("job", "title")
      .sort({ createdAt: -1 })
      .limit(10),

    jobModel.findOne({ status: "published" }).then(async job => {
      if (!job) return null;
      const assignedCount = await JobAssignment.countDocuments({
        job: job._id,
        status: { $in: ["accepted", "in-progress", "completed"] },
      });
      return assignedCount === 0 ? job : null;
    }),
  ]);

  const hoursThisWeek = hoursThisWeekAgg[0]?.total ?? 0;

  const dayMap: Record<number, string> = {
    2: "Mon", 3: "Tue", 4: "Wed", 5: "Thu", 6: "Fri", 7: "Sat", 1: "Sun",
  };
  const hoursByDay = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(day => {
    const match = hoursByDayAgg.find((h: any) => dayMap[h._id] === day);
    return { day, hours: match ? Math.round(match.total) : 0 };
  });

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
        total: Math.round(hoursThisWeek),
        target: totalWorkersCount * 80,
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