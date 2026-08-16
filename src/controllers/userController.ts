// @ts-ignore
import { StatusCodes } from "http-status-codes";
import mongoose from "mongoose";
import { NotFoundError, UnauthenticatedError, UnauthorizedError } from "../errors/customErrors.js";
import { getReqUser, MiddlewareFn } from "../interfaces/expresstype.js";
import JobAssignment from "../models/JobAssignment.js";
import userModel from "../models/userModel.js";
import { toUtcDay } from "../utils/dates.js";
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
  const { search } = req.query;
  const currentUser = req.user;

  const queryObject: any = {
    _id: { $ne: currentUser.user_id },
    // isActive: true,
  };

  if (currentUser.role === "admin") {
    // Admin sees everyone but themselves
    queryObject.role = { $in: ["manager", "worker"] };
  } else if (currentUser.role === "manager") {
    // Managers only see workers — not each other, not the admin
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
export const getWorkerStats: MiddlewareFn = async (req, res) => {
  const { id } = req.params;
  const currentUser = getReqUser(req);

  if (!["admin", "manager"].includes(currentUser.role)) {
    throw new UnauthorizedError("Not allowed to view worker stats");
  }

  const worker = await userModel.findById(id).lean();
  if (!worker) throw new NotFoundError("Worker not found");

  const weekStart = dayjs.utc().startOf("week").toDate();

  const [agg] = await JobAssignment.aggregate([
    { $match: { worker: new mongoose.Types.ObjectId(id as string) } },
    {
      $addFields: {
        // Worked minutes, net of breaks — mirrors the virtual, which
        // aggregations can't use.
        workedMinutes: {
          $cond: [
            { $and: ["$checkedInAt", "$checkedOutAt"] },
            {
              $subtract: [
                { $dateDiff: { startDate: "$checkedInAt", endDate: "$checkedOutAt", unit: "minute" } },
                {
                  $sum: {
                    $map: {
                      input: { $ifNull: ["$breaks", []] },
                      as: "b",
                      in: {
                        $cond: [
                          "$$b.endedAt",
                          { $dateDiff: { startDate: "$$b.startedAt", endDate: "$$b.endedAt", unit: "minute" } },
                          0,
                        ],
                      },
                    },
                  },
                },
              ],
            },
            0,
          ],
        },
      },
    },
    {
      $group: {
        _id: null,
        jobsCompleted: {
          $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
        },
        jobsAccepted: {
          $sum: { $cond: [{ $in: ["$status", ["accepted", "in-progress", "completed"]] }, 1, 0] },
        },
        jobsDeclined: {
          $sum: { $cond: [{ $eq: ["$status", "declined"] }, 1, 0] },
        },
        totalAssignments: { $sum: 1 },
        totalMinutes: { $sum: "$workedMinutes" },
        minutesThisWeek: {
          $sum: {
            $cond: [{ $gte: ["$checkedInAt", weekStart] }, "$workedMinutes", 0],
          },
        },
      },
    },
  ]);

  const stats = agg ?? {
    jobsCompleted: 0,
    jobsAccepted: 0,
    jobsDeclined: 0,
    totalAssignments: 0,
    totalMinutes: 0,
    minutesThisWeek: 0,
  };

  // Upcoming and in-progress assignments for the "Assigned Jobs" list
  const assignedJobs = await JobAssignment.find({
    worker: id,
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

  const respondedTo = stats.jobsAccepted + stats.jobsDeclined;

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
      hoursThisWeek: Math.round((stats.minutesThisWeek / 60) * 10) / 10,
      totalHours: Math.round((stats.totalMinutes / 60) * 10) / 10,
      jobsCompleted: stats.jobsCompleted,
      totalAssignments: stats.totalAssignments,
      // "Reliability" — how often they accept when asked. More meaningful
      // than a rating you have no way to collect.
      acceptanceRate: respondedTo ? Math.round((stats.jobsAccepted / respondedTo) * 100) : null,
    },
    assignedJobs: assignedJobs.filter(a => a.job),
  });
};
export const getStaticUser: MiddlewareFn = async (req, res) => {
  const user_id = req.params.userId;
  const user = await userModel.findOne({ _id: user_id });
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
