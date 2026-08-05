import { StatusCodes } from "http-status-codes";
import { BadRequestError } from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import Job from "../models/jobModel.js";
export const getCalendarJobs: MiddlewareFn = async (req, res) => {
    const { start, end } = req.query; // e.g. ?start=2026-08-01&end=2026-08-31
    if (!start || !end) {
        throw new BadRequestError("start and end date range required");
    }

    const jobs = await Job.find({
        date: { $gte: new Date(start as string), $lte: new Date(end as string) },
        // recurringJob: null, // exclude template jobs if you flag them; see note below
        status: { $ne: "draft" },
    })
        .sort({ date: 1, startTime: 1 })
        .lean();

    res.status(StatusCodes.OK).json({ jobs });
};