import { StatusCodes } from "http-status-codes";
import mongoose from "mongoose";
import { BadRequestError, NotFoundError, UnauthenticatedError } from "../errors/customErrors.js";
import { getReqUser, MiddlewareFn } from "../interfaces/expresstype.js";
import JobAssignment from "../models/JobAssignment.js";
import jobModel from "../models/jobModel.js";
import userModel from "../models/userModel.js";
import { hashPassword } from "../utils/passwordUtils.js";
import { logActivity } from "../utils/logActivity.js";
import recurringJobModel from "../models/recurringJobModel.js";
import dayjs from "dayjs";
import Company from "../models/company.js";
import { scheduledEndOf, scheduledStartOf, TZ } from "../utils/dates.js";

export const createWorker: MiddlewareFn = async (req, res) => {
    const { fullname, email, password, role } = req.body;
    const currentUser = req.user;
    const User = await userModel.findOne({ _id: req.user.user_id })
    if (!User) throw new BadRequestError("could not find user but this is impossible ")

    if (["admin"].includes(role)) {
        throw new BadRequestError("Invalid role. Only 'worker or manager' role can be created.");
    }


    const existingUser = await userModel.findOne({ email: email.toLowerCase() });
    if (existingUser) {
        throw new BadRequestError("Email already exists")
    }

    const hashedPassword = await hashPassword(password);

    const worker = await userModel.create({
        fullname,
        email: email.toLowerCase(),
        password: hashedPassword,
        role: role,
        createdBy: currentUser.user_id,
        company: User?.company
    });

    res.status(StatusCodes.CREATED).json({
        message: "Worker created successfully.",
        worker,
    });
};

export const getMyJobs: MiddlewareFn = async (req, res) => {
    const startTime = new Date()
    const workerId = new mongoose.Types.ObjectId(req.user.user_id);
    const { search, status, page = "1", limit = "10" } = req.query;

    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit as string, 10) || 20);

    const assignmentMatch: Record<string, any> = { worker: workerId };
    if (status && status !== "all") {
        assignmentMatch.status = status;
    }

    const lookupJob: mongoose.PipelineStage.Lookup = {
        $lookup: {
            from: "jobs", // Mongoose lowercases + pluralizes "Job" -> "jobs" by default; adjust if you overrode the collection name
            let: { jobId: "$job" },
            pipeline: [
                { $match: { $expr: { $eq: ["$_id", "$$jobId"] }, isDeleted: false } },
            ],
            as: "job",
        },
    };
    const unwindJob: mongoose.PipelineStage.Unwind = { $unwind: "$job" };
    const projectRow: mongoose.PipelineStage.Project = {
        $project: {
            job: 1,
            status: 1, // assignment status overrides job's own status, same as before
            workerJobDetails: {
                assignmentId: "$_id",
                acceptedAt: "$acceptedAt",
                declinedAt: "$declinedAt",
                checkedInAt: "$checkedInAt",
                checkedOutAt: "$checkedOutAt",
                completedAt: "$completedAt",
                hoursWorked: "$hoursWorked",
            },
        },
    };

    // The job join has to happen BEFORE the facet (not just inside the data
    // branch) because it also drops assignments whose job was soft-deleted.
    // If skip/limit ran first, a deleted job in the current page would leave
    // that page short instead of backfilling from the next one, and
    // totalCount would count assignments that can never appear in any page.
    const pipeline: mongoose.PipelineStage[] = [
        { $match: assignmentMatch },
        { $sort: { createdAt: -1 as const } },
        lookupJob,
        unwindJob,
        ...(search ? [{ $match: { "job.title": { $regex: search as string, $options: "i" } } }] : []),
        {
            $facet: {
                data: [
                    { $skip: (pageNum - 1) * limitNum },
                    { $limit: limitNum },
                    projectRow,
                ],
                totalCount: [{ $count: "count" }],
            },
        },
    ];

    const [result] = await JobAssignment.aggregate(pipeline);
    const total = result.totalCount[0]?.count ?? 0;

    const jobs = result.data.map((row: any) => ({
        ...row.job,
        status: row.status, // assignment status wins over job.status, same behavior as your original .map
        workerJobDetails: row.workerJobDetails,
    }));
    const time_querying = dayjs().diff(startTime, "seconds", true)
    console.log("time quering is : ", time_querying)
    res.status(StatusCodes.OK).json({
        jobs,
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
    });
};

// Self-service total for the logged-in worker: sums hoursWorked across their
// completed assignments, optionally scoped to a date range via completedAt.
export const getMyTotalHours: MiddlewareFn = async (req, res) => {
    const workerId = new mongoose.Types.ObjectId(req.user.user_id);
    const { start, end } = req.query;

    const match: Record<string, any> = { worker: workerId, status: "completed" };

    if (start || end) {
        const completedAt: Record<string, Date> = {};
        if (start) {
            const startDate = new Date(start as string);
            if (isNaN(startDate.getTime())) throw new BadRequestError("Invalid start date");
            completedAt.$gte = startDate;
        }
        if (end) {
            const endDate = new Date(end as string);
            if (isNaN(endDate.getTime())) throw new BadRequestError("Invalid end date");
            completedAt.$lte = endDate;
        }
        match.completedAt = completedAt;
    }

    const [result] = await JobAssignment.aggregate([
        { $match: match },
        {
            $group: {
                _id: null,
                totalHours: { $sum: "$hoursWorked" },
                totalJobs: { $sum: 1 },
            },
        },
    ]);

    res.status(StatusCodes.OK).json({
        success: true,
        totalHours: result?.totalHours ?? 0,
        totalJobs: result?.totalJobs ?? 0,
    });
};

const ASSIGNMENT_STATUSES = ["pending", "accepted", "declined", "in-progress", "completed", "cancelled"] as const;

// Self-service dashboard summary for the logged-in worker. One aggregation,
// three facets: job counts by status (all-time), hours/pay stats from
// completed work (all-time), and earnings for the current calendar month.
// Add more facets here as new stats are needed.
export const getWorkerDashboardStats: MiddlewareFn = async (req, res) => {
    const workerId = new mongoose.Types.ObjectId(req.user.user_id);
    const monthStart = dayjs().startOf("month").toDate();
    const monthEnd = dayjs().endOf("month").toDate();

    const [result] = await JobAssignment.aggregate([
        { $match: { worker: workerId } },
        {
            $facet: {
                statusCounts: [
                    { $group: { _id: "$status", count: { $sum: 1 } } },
                ],
                completedStats: [
                    { $match: { status: "completed" } },
                    {
                        $group: {
                            _id: null,
                            hoursWorked: { $sum: "$hoursWorked" },
                            averagePayRate: { $avg: "$payRate" },
                        },
                    },
                ],
                monthlyEarnings: [
                    { $match: { status: "completed", completedAt: { $gte: monthStart, $lte: monthEnd } } },
                    { $group: { _id: null, earnings: { $sum: "$totalPay" } } },
                ],
            },
        },
    ]);

    const jobStats = Object.fromEntries(ASSIGNMENT_STATUSES.map(status => [status, 0])) as Record<typeof ASSIGNMENT_STATUSES[number], number>;
    for (const row of result.statusCounts) {
        jobStats[row._id as typeof ASSIGNMENT_STATUSES[number]] = row.count;
    }

    const completed = result.completedStats[0] ?? {};
    const monthly = result.monthlyEarnings[0] ?? {};
    const total_job_completed = Object.values(jobStats).reduce((acc, next) => acc + next)
    res.status(StatusCodes.OK).json({
        success: true,
        jobStats,
        hoursWorked: completed.hoursWorked ?? 0,
        averagePayRate: completed.averagePayRate ?? 0,
        monthlyEarnings: monthly.earnings ?? 0,
        total_job_completed
    });
};

export const getJob: MiddlewareFn = async (req, res) => {
    const { id } = req.params;

    const [job, jobAssignment] = await Promise.all([
        jobModel.findOne({ _id: id, isDeleted: false }),
        JobAssignment.findOne({ job: id, worker: req.user.user_id, isDeleted: false }),
    ]);
    if (!job) {
        throw new BadRequestError("Job not found.");
    }
    if (!jobAssignment) {
        throw new NotFoundError("You are not assigned to this job.");
    }

    const job_ = {
        ...job.toObject(),
        status: jobAssignment.status,
        workerJobDetails: jobAssignment,
    };

    res.status(StatusCodes.OK).json({
        job: job_,
        success: true,
    });
};
export const getActiveJob: MiddlewareFn = async (req, res) => {
    const assignment = await JobAssignment.findOne({
        status: "in-progress",
        worker: req.user.user_id,
    })
        .populate({ path: "job", match: { isDeleted: false } })
        .lean();

    if (!assignment || !assignment.job) {
        res.status(StatusCodes.OK).json({ success: true, job: null });
        return;
    }

    res.status(StatusCodes.OK).json({
        success: true,
        job: {
            ...(assignment.job as any),
            status: assignment.status,
            workerJobDetails: assignment,
        },
    });
};

// Single source of truth for worker-driven status transitions.
// checkInJob below now just calls this instead of duplicating the logic.
export const updateWorkerJobStatus: MiddlewareFn = async (req, res) => {
    const { id } = req.params;
    const { status, reason } = req.body;

    const allowedStatuses = ["accepted", "declined", "in-progress", "completed"];
    if (!allowedStatuses.includes(status)) {
        throw new BadRequestError("Invalid status");
    }

    const workerId = getReqUser(req).user_id;

    const assignment = await JobAssignment.findOne({ worker: workerId, job: id });
    if (!assignment) {
        throw new NotFoundError("You are not assigned to this job.");
    }

    const job = await jobModel.findOne({ _id: assignment.job, isDeleted: false }).lean();
    if (!job) throw new NotFoundError("Job not found.");

    const now = new Date();
    const scheduledStart = scheduledStartOf(job);
    const scheduledEnd = scheduledEndOf(job);

    switch (status) {
        case "accepted": {
            if (assignment.status !== "pending") {
                throw new BadRequestError(`You cannot accept a job that is ${assignment.status}.`);
            }

            assignment.status = "accepted";
            assignment.acceptedAt = now;

            await logActivity({
                job: assignment.job,
                jobDate: job.date,
                assignment: assignment._id,
                worker: assignment.worker,
                type: "assignment_accepted",
                actor: workerId,
                metadata: {
                    // How long they took to respond after being assigned
                    responseMinutes: Math.round(
                        (now.getTime() - new Date(assignment.createdAt).getTime()) / 60_000
                    ),
                },
            });
            break;
        }

        case "declined": {
            if (assignment.status !== "pending") {
                throw new BadRequestError(`You cannot decline a job that is ${assignment.status}.`);
            }

            assignment.status = "declined";
            assignment.declinedAt = now;
            assignment.cancellationReason = (reason ?? "").trim();

            await logActivity({
                job: assignment.job,
                jobDate: job.date,
                assignment: assignment._id,
                worker: assignment.worker,
                type: "assignment_declined",
                actor: workerId,
                metadata: {
                    reason: assignment.cancellationReason || null,
                    responseMinutes: Math.round(
                        (now.getTime() - new Date(assignment.createdAt).getTime()) / 60_000
                    ),
                    // How much notice the manager has to backfill
                    hoursNotice: Math.round((scheduledStart.getTime() - now.getTime()) / 3_600_000),
                },
            });
            break;
        }

        case "in-progress": {
            if (assignment.status !== "accepted") {
                throw new BadRequestError("You must accept the job before starting it.");
            }
            if (assignment.checkedInAt) {
                throw new BadRequestError("You have already checked in.");
            }

            // Guards run BEFORE any mutation
            const hasActiveJob = await JobAssignment.exists({
                worker: workerId,
                status: "in-progress",
            });
            if (hasActiveJob) {
                throw new BadRequestError(
                    "You already have an active job — complete it before starting another."
                );
            }

            const EARLY_GRACE_MINUTES = 30;
            const earliest = new Date(scheduledStart.getTime() - EARLY_GRACE_MINUTES * 60_000);

            if (now < earliest) {
                throw new BadRequestError(
                    `This shift starts at ${job.startTime} on ${dayjs(job.date).tz(TZ).format("D MMM")}. You can clock in from ${dayjs(earliest).tz(TZ).format("HH:mm")}.`
                );
            }
            if (now > scheduledEnd) {
                throw new BadRequestError("This shift has already ended. Contact your manager.");
            }

            assignment.checkedInAt = now;
            assignment.status = "in-progress";

            // Positive = late, negative = early
            const minutesLate = Math.round((now.getTime() - scheduledStart.getTime()) / 60_000);

            await logActivity({
                job: assignment.job,
                jobDate: job.date,
                assignment: assignment._id,
                worker: assignment.worker,
                type: "assignment_checked_in",
                actor: workerId,
                metadata: {
                    minutesLate,
                    location: job.location,
                    scheduledStart,
                },
            });
            break;
        }

        case "completed": {
            if (assignment.status !== "in-progress") {
                throw new BadRequestError("You must start the job before completing it.");
            }
            if (!assignment.checkedInAt) {
                throw new BadRequestError("No check-in recorded for this shift.");
            }

            const openBreak = assignment.breaks?.find(b => !b.endedAt);
            if (openBreak) openBreak.endedAt = now;

            assignment.checkedOutAt = now;
            assignment.completedAt = now;
            assignment.status = "completed";

            const grossMinutes = Math.round(
                (now.getTime() - new Date(assignment.checkedInAt).getTime()) / 60_000
            );
            const breakMinutes = (assignment.breaks ?? []).reduce(
                (sum, b) =>
                    b.endedAt
                        ? sum + Math.round((new Date(b.endedAt).getTime() - new Date(b.startedAt!).getTime()) / 60_000)
                        : sum,
                0
            );

            await logActivity({
                job: assignment.job,
                jobDate: job.date,
                assignment: assignment._id,
                worker: assignment.worker,
                type: "assignment_checked_out",
                actor: workerId,
                metadata: {
                    workedMinutes: Math.max(0, grossMinutes - breakMinutes),
                    breakMinutes,
                    breakCount: (assignment.breaks ?? []).length,
                    scheduledMinutes: job.minutes,
                    // Positive = left early, negative = stayed late
                    minutesEarly: Math.round((scheduledEnd.getTime() - now.getTime()) / 60_000),
                },
            });
            break;
        }
    }

    await assignment.save();

    res.status(StatusCodes.OK).json({
        success: true,
        message: `Job ${status} successfully.`,
        assignment,
    });
};
export const startWorkerBreak: MiddlewareFn = async (req, res) => {
    const { id } = req.params;

    const assignment = await JobAssignment.findOne({
        worker: req.user.user_id,
        job: id,
    });

    if (!assignment) {
        throw new NotFoundError("You are not assigned to this job.");
    }
    if (assignment.status !== "in-progress") {
        throw new BadRequestError("You can only take a break while the job is in progress.");
    }
    const openBreak = assignment.breaks?.find(b => !b.endedAt);
    if (openBreak) {
        throw new BadRequestError("You are already on a break.");
    }

    assignment.breaks?.push({ startedAt: new Date() });
    await assignment.save();

    await logActivity({
        job: assignment.job,
        assignment: assignment._id,
        worker: assignment.worker,
        type: "assignment_break_started",
        actor: req.user.user_id,
    });

    res.status(StatusCodes.OK).json({
        success: true,
        message: "Break started.",
        assignment,
    });
};

export const endWorkerBreak: MiddlewareFn = async (req, res) => {
    const { id } = req.params;

    const assignment = await JobAssignment.findOne({
        worker: req.user.user_id,
        job: id,
    });

    if (!assignment) {
        throw new NotFoundError("You are not assigned to this job.");
    }

    const openBreak = assignment.breaks?.find(b => !b.endedAt);
    if (!openBreak) {
        throw new BadRequestError("You are not currently on a break.");
    }
    openBreak.endedAt = new Date();
    await assignment.save();

    await logActivity({
        job: assignment.job,
        assignment: assignment._id,
        worker: assignment.worker,
        type: "assignment_break_ended",
        actor: req.user.user_id,
    });

    res.status(StatusCodes.OK).json({
        success: true,
        message: "Break ended.",
        assignment,
    });
};

export const declineRecurringSeries: MiddlewareFn = async (req, res) => {
    const { id: recurringJobId } = req.params;
    const workerId = getReqUser(req).user_id;

    await recurringJobModel.updateOne(
        { _id: recurringJobId },
        { $pull: { defaultWorkers: workerId } }
    );

    const futureJobIds = await jobModel.find({
        recurringJob: recurringJobId,
        date: { $gte: new Date() },
        isDeleted: false,
    }).distinct("_id");

    await JobAssignment.updateMany(
        { job: { $in: futureJobIds }, worker: workerId, status: "pending" },
        { status: "declined", declinedAt: new Date() }
    );

    res.status(StatusCodes.OK).json({ success: true });
};
// Thin wrapper so there's one route for check-in but no duplicated business logic
export const checkInJob: MiddlewareFn = async (req, res) => {
    req.body.status = "in-progress";
    return updateWorkerJobStatus(req, res, () => { });
};