import { StatusCodes } from "http-status-codes";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import { BadRequestError } from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import Job from "../models/jobModel.js";
import JobAssignment from "../models/JobAssignment.js";

dayjs.extend(utc);

export const getCalendarJobs: MiddlewareFn = async (req, res) => {
  const { start, end } = req.query;

  if (!start || !end) {
    throw new BadRequestError("start and end date range required");
  }

  const rangeStart = dayjs.utc(start as string).startOf("day");
  const rangeEnd = dayjs.utc(end as string).add(1, "day").startOf("day");

  if (!rangeStart.isValid() || !rangeEnd.isValid()) {
    throw new BadRequestError("Invalid date range");
  }

  const jobs = await Job.find({
    company: req.user.company_id.toString(),
    date: {
      $gte: rangeStart.toDate(),
      $lt: rangeEnd.toDate(), // exclusive upper bound = whole final day included
    },
    status: { $ne: "draft" },
    isDeleted: false,
  })
    .populate("client", "name")
    .sort({ date: 1, startTime: 1 })
    .lean();

  // Job has no embedded worker list of its own — assignments live on
  // JobAssignment. The month/day views render assigned-worker avatars, so
  // this batch-fetches and flattens the same way getAllJobs does for the
  // Jobs list, rather than leaving `job.workers` undefined.
  const assignments = await JobAssignment.find({
    job: { $in: jobs.map(job => job._id) },
    isDeleted: false,
  })
    .populate("worker", "fullname email profilePhoto")
    .lean();

  const workersByJob = assignments.reduce((acc, a: any) => {
    const key = a.job.toString();
    (acc[key] ??= []).push({
      ...a,
      email: a.worker?.email,
      profilePhoto: a.worker?.profilePhoto ?? null,
      worker: a.worker?._id,
    });
    return acc;
  }, {} as Record<string, unknown[]>);

  const result = jobs.map(job => ({
    ...job,
    workers: workersByJob[job._id.toString()] ?? [],
  }));

  res.status(StatusCodes.OK).json({ jobs: result });
};