import { StatusCodes } from "http-status-codes";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import ActivityLog from "../models/ActivityLog.js";
// comment here 
export const getJobTimeline: MiddlewareFn = async (req, res) => {
    // edit activity_log controlleer
    const { id: jobId } = req.params;
    // change thios code when crating eventory later in the future thanks 

    const activity = await ActivityLog.find({ job: jobId })
        .sort({ createdAt: 1 }) // oldest first, matching your example (top = earliest)
        .populate("actor", "fullname")
        .populate("workers", "fullname");

    res.status(StatusCodes.OK).json({ activity });
};