// @ts-ignore
import { StatusCodes } from "http-status-codes";
import mongoose from "mongoose";
import { NotFoundError, UnauthenticatedError, UnauthorizedError } from "../errors/customErrors.js";
import { getReqUser, MiddlewareFn } from "../interfaces/expresstype.js";
import JobAssignment from "../models/JobAssignment.js";
import userModel from "../models/userModel.js";
import Company from "../models/company.js";
import ActivityLog from "../models/ActivityLog.js";
import { scheduledStartOf, toUtcDay, TZ } from "../utils/dates.js";
import dayjs from "../utils/dayjsSetup.js";
import { sanitizeUser } from "../utils/tokenUtils.js";
export const currentUser: MiddlewareFn = async (req, res) => {
  // const { user_id } = getReqUser(req);
  const { user_id } = req.user
  const user = await userModel.findOne({ _id: user_id }).populate("company", "name plan maxWorkers")

  if (!user) throw new UnauthenticatedError(`login again `);
  // adding c
  let Iuser = sanitizeUser(user);
  Iuser = {
    ...Iuser,
  };
  // console.log("this is the login user", Iuser, user);
  res.status(StatusCodes.OK).json({ user: Iuser });
};
export const getAllUser: MiddlewareFn = async (
  req,
  res
): Promise<void> => {
  const { search, role } = req.query;
  const currentUser = req.user;
  console.log("this is the role",role)
  // if(role)
  const queryObject: any = {
    _id: { $ne: currentUser.user_id },
    // isActive: true,
    // Cast explicitly: aggregate()'s $match below sends this straight to
    // MongoDB with no Mongoose auto-casting, so a raw string here (as
    // req.user.company_id is, straight off the JWT) silently matches
    // nothing against the ObjectId-typed `company` field.
    company: new mongoose.Types.ObjectId(req.user.company_id.toString()),
  };
  if (currentUser.role === "admin") {
    // Admin sees everyone but themselves, optionally narrowed to just one role
    queryObject.role = role === "worker" || role === "manager" ? role : { $in: ["manager", "worker"] };
  } else if (currentUser.role === "manager") {
    // Managers only see workers — not each other, not the admin — regardless
    // of what `role` was requested
    queryObject.role = "worker";
  } else {
    // Workers shouldn't be listing users at all
    throw new UnauthorizedError("Not allowed to view users");
  }
  // queryObject.createdBy = re
  if (search) {
    const userSearch = [
      {
        fullname: { $regex: search, $options: "i" },
      },
      {
        email: { $regex: search, $options: "i" },
      },
    ];
    // console.log(Number(search))

    queryObject.$or = [...userSearch];
  }
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 20;
  const skip = (page - 1) * limit;
  // testing
  const totalUsers = await userModel.countDocuments(queryObject);
  // in getAllUser — one aggregation, no extra requests
  const weekStart = dayjs.utc().startOf("isoWeek").toDate();
  const users = await userModel.aggregate([
    { $match: queryObject },
    { $sort: { createdAt: -1 } },
    { $skip: skip },
    { $limit: limit },
    {
      $lookup: {
        from: "jobassignments",
        let: { workerId: "$_id" },
        pipeline: [
          { $match: { $expr: { $eq: ["$worker", "$$workerId"] } } },
          {
            $group: {
              _id: null,
              jobsCompleted: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
              minutesThisWeek: {
                $sum: {
                  $cond: [
                    { $and: [{ $gte: ["$checkedInAt", weekStart] }, "$checkedOutAt"] },
                    { $dateDiff: { startDate: "$checkedInAt", endDate: "$checkedOutAt", unit: "minute" } },
                    0,
                  ],
                },
              },
            },
          },
        ],
        as: "stats",
      },
    },
    {
      $addFields: {
        jobsCompleted: { $ifNull: [{ $first: "$stats.jobsCompleted" }, 0] },
        hoursThisWeek: {
          $round: [{ $divide: [{ $ifNull: [{ $first: "$stats.minutesThisWeek" }, 0] }, 60] }, 1],
        },
      },
    },
    { $project: { password: 0, refreshToken: 0, stats: 0 } },
  ]);
  const numberOfPage = Math.ceil(totalUsers / limit);

  res.status(200).json({ users, numberOfPage, limit, currentPage: page, nHits: totalUsers });
};
// Net of unpaid breaks — the same arithmetic as JobAssignment's
// `workedMinutes` virtual, just usable here without hydrating a full
// Mongoose document for every row.
const workedMinutesOf = (a: {
  checkedInAt?: Date | null;
  checkedOutAt?: Date | null;
  breaks?: { startedAt?: Date | null; endedAt?: Date | null }[];
}): number => {
  if (!a.checkedInAt || !a.checkedOutAt) return 0;
  const gross = Math.round((a.checkedOutAt.getTime() - a.checkedInAt.getTime()) / 60_000);
  const breakMins = (a.breaks ?? []).reduce(
    (sum, b) => (b.startedAt && b.endedAt ? sum + Math.round((b.endedAt.getTime() - b.startedAt.getTime()) / 60_000) : sum),
    0
  );
  return Math.max(0, gross - breakMins);
};

const round1 = (n: number): number => Math.round(n * 10) / 10;

export const getWorkerStats: MiddlewareFn = async (req, res) => {
  const { id } = req.params;
  const currentUser = getReqUser(req);

  if (!["admin", "manager"].includes(currentUser.role)) {
    throw new UnauthorizedError("Not allowed to view worker stats");
  }

  const worker = await userModel.findOne({ _id: id, company: currentUser.company_id }).lean();
  if (!worker) throw new NotFoundError("Worker not found");

  const company = await Company.findById(currentUser.company_id)
    .select("clockInGraceMinutes timezone")
    .lean();
  const tz = company?.timezone ?? TZ;
  const graceMs = (company?.clockInGraceMinutes ?? 30) * 60_000;

  // Everything downstream (this week/month, the trend, on-time %, utilisation)
  // is easier and more correct computed here in JS with the worker's actual
  // shift times than reconstructed inside an aggregation pipeline — the
  // date+startTime → real-datetime math (scheduledStartOf) already exists
  // and is timezone-aware; duplicating it in Mongo expression syntax would
  // just be a second place for that logic to drift out of sync.
  const assignments = await JobAssignment.find({ worker: id, isDeleted: false })
    .populate<{
      job: {
        _id: mongoose.Types.ObjectId;
        title: string;
        location: string;
        priority: string;
        date: Date;
        startTime: string;
        endTime: string;
        minutes: number;
      } | null;
    }>("job", "title location priority date startTime endTime minutes")
    .sort({ createdAt: -1 })
    .limit(2000)
    .lean();

  const now = dayjs().tz(tz);
  const weekStart = now.startOf("isoWeek");
  const monthStart = now.startOf("month");
  // Oldest first, so index 0 is 6 weeks ago and the last entry is the
  // current (possibly partial) week — reads left-to-right on a trend chart.
  const weekBuckets = Array.from({ length: 7 }, (_, i) => {
    const start = weekStart.subtract(6 - i, "week");
    return { start, end: start.add(1, "week"), minutes: 0 };
  });

  let jobsCompleted = 0;
  let jobsAccepted = 0; // committed: accepted, in-progress, or completed
  let jobsDeclined = 0;
  let totalMinutes = 0;
  let minutesThisWeek = 0;
  let minutesThisMonth = 0;
  let onTimeCount = 0;
  let checkedInCount = 0;
  let scheduledMinutesWorked = 0; // the flip side of totalMinutes, for utilisation

  for (const a of assignments) {
    if (a.status === "completed") jobsCompleted++;
    if (a.status === "accepted" || a.status === "in-progress" || a.status === "completed") jobsAccepted++;
    if (a.status === "declined") jobsDeclined++;

    const minutes = workedMinutesOf(a);
    totalMinutes += minutes;

    if (a.checkedInAt) {
      const checkedInAt = dayjs(a.checkedInAt).tz(tz);
      if (!checkedInAt.isBefore(weekStart)) minutesThisWeek += minutes;
      if (!checkedInAt.isBefore(monthStart)) minutesThisMonth += minutes;

      const bucket = weekBuckets.find(b => checkedInAt.isSameOrAfter(b.start) && checkedInAt.isBefore(b.end));
      if (bucket) bucket.minutes += minutes;

      if (a.job) {
        checkedInCount++;
        const scheduledStart = scheduledStartOf(a.job, tz);
        if (a.checkedInAt.getTime() <= scheduledStart.getTime() + graceMs) onTimeCount++;
      }
    }

    if (a.job && (a.status === "completed" || a.status === "in-progress")) {
      scheduledMinutesWorked += a.job.minutes;
    }
  }

  // Upcoming and in-progress assignments for the "Assigned Jobs" list
  const assignedJobs = await JobAssignment.find({
    worker: id,
    isDeleted: false,
    status: { $in: ["pending", "accepted", "in-progress"] },
  })
    .populate({
      path: "job",
      match: { date: { $gte: toUtcDay(new Date()) }, isDeleted: false },
      select: "title date startTime endTime location status",
    })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  const respondedTo = jobsAccepted + jobsDeclined;
  const totalAssignments = assignments.length;

  // Reuses the same assignments already fetched for the stats above —
  // most-recently-created first, capped so the profile page isn't hydrating
  // years of history on every load.
  const jobHistory = assignments
    .filter(a => a.job)
    .slice(0, 50)
    .map(a => ({
      _id: a._id,
      jobId: a.job!._id,
      title: a.job!.title,
      location: a.job!.location,
      priority: a.job!.priority,
      date: a.job!.date,
      startTime: a.job!.startTime,
      endTime: a.job!.endTime,
      status: a.status,
      hours: round1(workedMinutesOf(a) / 60),
    }));

  // Designed for exactly this — see the {worker:1, createdAt:-1} index on
  // ActivityLog. `worker` is already company-verified above via the lookup
  // that resolved `worker`, so no separate company filter is needed here.
  const recentActivity = await ActivityLog.find({ worker: id })
    .sort({ createdAt: -1 })
    .limit(10)
    .populate("job", "title")
    .select("type job createdAt metadata")
    .lean();

  res.status(StatusCodes.OK).json({
    success: true,
    worker: {
      _id: worker._id,
      fullname: worker.fullname,
      email: worker.email,
      phone: worker.phone ?? null,
      role: worker.role,
      isActive: worker.isActive,
      createdAt: worker.createdAt,
    },
    stats: {
      hoursThisWeek: round1(minutesThisWeek / 60),
      hoursThisMonth: round1(minutesThisMonth / 60),
      totalHours: round1(totalMinutes / 60),
      jobsCompleted,
      totalAssignments,
      avgHoursPerJob: jobsCompleted ? round1(totalMinutes / jobsCompleted / 60) : 0,
      // Of the shifts they committed to (accepted/in-progress/completed),
      // how many did they actually see through to completion.
      completionRate: jobsAccepted ? Math.round((jobsCompleted / jobsAccepted) * 100) : null,
      // "Reliability" — how often they accept when asked.
      acceptanceRate: respondedTo ? Math.round((jobsAccepted / respondedTo) * 100) : null,
      onTimeArrivalRate: checkedInCount ? Math.round((onTimeCount / checkedInCount) * 100) : null,
      // Actual worked time against what those same shifts were scheduled
      // for — a number consistently under 100% usually means early
      // clock-outs or unpaid-break creep, not that they're underworked.
      hoursUtilisationRate: scheduledMinutesWorked
        ? Math.round((totalMinutes / scheduledMinutesWorked) * 100)
        : null,
    },
    hoursTrend: weekBuckets.map(b => ({
      weekStart: b.start.format("YYYY-MM-DD"),
      hours: round1(b.minutes / 60),
    })),
    assignedJobs: assignedJobs.filter(a => a.job),
    jobHistory,
    recentActivity,
  });
};
export const getStaticUser: MiddlewareFn = async (req, res) => {
  const user_id = req.params.userId;
  const user = await userModel.findOne({ _id: user_id, company: req.user.company_id });
  if (!user)
    throw new UnauthenticatedError(`
  couldnot found user with id ${user_id}
  `);
  let Iuser = sanitizeUser(user);
  Iuser = {
    ...Iuser,
    fullname: Iuser.name,
  };
  // console.log("this is the login user", Iuser, user);
  res.status(StatusCodes.OK).json({ user: Iuser });
};
