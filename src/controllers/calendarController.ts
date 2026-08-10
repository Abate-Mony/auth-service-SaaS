import { StatusCodes } from "http-status-codes";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import { BadRequestError } from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import Job from "../models/jobModel.js";

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
    date: {
      $gte: rangeStart.toDate(),
      $lt: rangeEnd.toDate(), // exclusive upper bound = whole final day included
    },
    status: { $ne: "draft" },
    isDeleted: false,
  })
    .sort({ date: 1, startTime: 1 })
    .lean();

  res.status(StatusCodes.OK).json({ jobs });
};