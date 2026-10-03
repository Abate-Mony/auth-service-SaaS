import { StatusCodes } from "http-status-codes";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import jobModel from "../models/jobModel.js";
import userModel from "../models/userModel.js";
import WorkerAvailability from "../models/WorkerAvailability.js";
import { getAvailabilityForShift, isValidTime } from "../utils/availability.js";

const DAY_STATUSES = ["available", "unavailable", "hours"] as const;

// GET /availability/me — the worker's weekly pattern. Always returns all
// seven days (defaulting to "available"), whether or not they've saved one.
export const getMyAvailability: MiddlewareFn = async (req, res) => {
    const doc = await WorkerAvailability.findOne({ worker: req.user.user_id }).lean();

    const days = [1, 2, 3, 4, 5, 6, 7].map(day => {
        const saved = doc?.days?.find(d => d.day === day);
        return {
            day,
            status: saved?.status ?? "available",
            start: saved?.start ?? null,
            end: saved?.end ?? null,
        };
    });

    res.status(StatusCodes.OK).json({
        success: true,
        availability: { days, note: doc?.note ?? "", isSet: !!doc, updatedAt: doc?.updatedAt ?? null },
    });
};

// PUT /availability/me — replace the whole weekly pattern.
// Body: { days: [{ day: 1-7, status, start?, end? }], note? }
export const updateMyAvailability: MiddlewareFn = async (req, res) => {
    const { days, note } = req.body ?? {};
    if (!Array.isArray(days)) throw new BadRequestError("days must be an array.");

    const seen = new Set<number>();
    const cleaned = days.map((d: any) => {
        const day = Number(d?.day);
        if (!Number.isInteger(day) || day < 1 || day > 7) throw new BadRequestError("Each day must be 1 (Mon) to 7 (Sun).");
        if (seen.has(day)) throw new BadRequestError("Each day can only appear once.");
        seen.add(day);

        if (!DAY_STATUSES.includes(d?.status)) {
            throw new BadRequestError("status must be available, unavailable or hours.");
        }
        if (d.status !== "hours") return { day, status: d.status, start: null, end: null };

        if (!isValidTime(d.start) || !isValidTime(d.end)) {
            throw new BadRequestError("Hours need a start and end time (HH:mm).");
        }
        if (d.start >= d.end) throw new BadRequestError("End time must be after start time.");
        return { day, status: d.status, start: d.start, end: d.end };
    });

    const availability = await WorkerAvailability.findOneAndUpdate(
        { worker: req.user.user_id },
        {
            worker: req.user.user_id,
            company: req.user.company_id,
            days: cleaned,
            note: typeof note === "string" ? note.trim().slice(0, 300) : "",
        },
        { upsert: true, new: true, runValidators: true }
    ).lean();

    res.status(StatusCodes.OK).json({ success: true, availability });
};

// GET /availability/jobs/:jobId — every active worker at the company and
// whether they can make this job's shift. Advisory, for the manager's
// assign-workers screen; nothing is blocked based on it.
export const getJobAvailability: MiddlewareFn = async (req, res) => {
    const companyId = req.user.company_id.toString();

    const job = await jobModel.findOne({ _id: req.params.jobId, company: companyId, isDeleted: false })
        .select("date startTime endTime")
        .lean();
    if (!job) throw new NotFoundError("Job not found.");

    const workers = await userModel.find({ company: companyId, role: "worker", isActive: true }).select("_id").lean();
    const byWorker = await getAvailabilityForShift(job, workers.map(w => w._id));

    res.status(StatusCodes.OK).json({
        success: true,
        availability: Object.fromEntries(byWorker),
    });
};
