import dayjs from "dayjs";
import { StatusCodes } from "http-status-codes";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { MiddlewareFn, getReqUser } from "../interfaces/expresstype.js";
import JobAssignment from "../models/JobAssignment.js";
import Job from "../models/jobModel.js";
import recurringJobModel from "../models/recurringJobModel.js";
import userModel from "../models/userModel.js";
import { generateOccurrences } from "../utils/generateOccurrences.js";
import { logActivity } from "../utils/logActivity.js";
import { toUtcDay } from "../utils/dates.js";
import company from "../models/company.js";

export const jobDurationMinutes = (startTime: string, endTime: string): number => {
    const [sh, sm] = startTime.split(":").map(Number);
    const [eh, em] = endTime.split(":").map(Number);

    if ([sh, sm, eh, em].some(n => Number.isNaN(n))) {
        throw new BadRequestError("Invalid start or end time — expected HH:mm");
    }

    let minutes = (eh * 60 + em) - (sh * 60 + sm);

    // Overnight shift: end at or before start means it rolls into the next day
    if (minutes <= 0) minutes += 24 * 60;

    return minutes;
};



export const createJob: MiddlewareFn = async (req, res): Promise<void> => {
    const {
        title,
        description,
        client,
        location,
        address,
        coordinates,
        date,
        startTime,
        endTime,
        requiredWorkers,
        priority,
        supervisor,
        payRate,
        chargeRate,
        notes,
        instructions,
        isRecurring,
        frequency,
        interval = 1,
        daysOfWeek,
        monthlyMode,
        monthlyWeekNum,
        monthlyWeekDay,
        endDate,
        maxOccurrences,
        generateAheadDays = 30,
    } = req.body;

    if (!startTime || !endTime) throw new BadRequestError("start or end time required");
    if (!date) throw new BadRequestError("A job date is required");

    const jobDate = toUtcDay(date);
    if (jobDate < toUtcDay(new Date())) {
        throw new BadRequestError("Job date cannot be in the past");
    }

    const currentUserId = getReqUser(req).user_id;

    // ── Resolve and validate assigned workers ────────────────────────────────
    let workers: any[] = [];
    if (req.body.workers) {
        try {
            workers = typeof req.body.workers === "string" ? JSON.parse(req.body.workers) : req.body.workers;
        } catch {
            throw new BadRequestError("Invalid workers payload");
        }
    }
    const workerEmails = workers.map(w => w.email).filter(Boolean);

    const realWorkers = workerEmails.length
        ? await userModel.find({ email: { $in: workerEmails }, isActive: true })
        : [];

    const foundEmails = new Set(realWorkers.map(u => u.email));
    const missingEmails = workerEmails.filter(e => !foundEmails.has(e));
    if (missingEmails.length) {
        throw new BadRequestError(`No active account found for: ${missingEmails.join(", ")}`);
    }

    const workerIds = realWorkers.map(w => w._id);

    // Allowlisted — never spread req.body, or clients can set isTemplate/status/createdBy
    console.log("requested_user ", req.user)
    const baseJobFields = {
        title,
        description,
        company: req.user.company_id,
        client: client ?? "",
        location,
        address: address ?? "",
        ...(coordinates ? { coordinates } : {}),
        date: jobDate,
        startTime,
        endTime,
        minutes: jobDurationMinutes(startTime, endTime),
        requiredWorkers: requiredWorkers ?? 1,
        priority: priority ?? "medium",
        ...(supervisor ? { supervisor } : {}),
        payRate: payRate ?? 0,
        chargeRate: chargeRate ?? 0,
        notes: notes ?? "",
        instructions: instructions ?? "",
        createdBy: currentUserId,
    };

    // ── Recurring job ──────────────────────────────────────────────────────
    if (isRecurring) {
        if (!["daily", "weekly", "monthly"].includes(frequency)) {
            throw new BadRequestError("Invalid frequency");
        }

        const intervalNum = Number(interval);
        if (!Number.isInteger(intervalNum) || intervalNum < 1) {
            throw new BadRequestError("interval must be a positive whole number");
        }

        let normalizedDaysOfWeek: number[] | undefined;
        if (frequency === "weekly") {
            if (!Array.isArray(daysOfWeek) || !daysOfWeek.length) {
                throw new BadRequestError("daysOfWeek is required for weekly recurrence");
            }
            normalizedDaysOfWeek = daysOfWeek.map(Number);
            if (normalizedDaysOfWeek.some(d => Number.isNaN(d) || d < 0 || d > 6)) {
                throw new BadRequestError("daysOfWeek values must be between 0 and 6");
            }
        }

        const normalizedEndDate = endDate ? toUtcDay(endDate) : undefined;
        if (normalizedEndDate && normalizedEndDate < jobDate) {
            throw new BadRequestError("endDate cannot be before the start date");
        }

        let templateJob;
        let recurringJob;
        let generatedJobs: any[] = [];

        try {
            // Template is never a real shift — draft + isTemplate keeps it out of
            // every calendar, list and dashboard query
            templateJob = await Job.create({
                ...baseJobFields,
                status: "draft",
                isTemplate: true,
            });

            recurringJob = await recurringJobModel.create({
                templateJob: templateJob._id,
                frequency,
                interval: intervalNum,
                daysOfWeek: normalizedDaysOfWeek,
                ...(frequency === "monthly" ? { monthlyMode, monthlyWeekNum, monthlyWeekDay } : {}),
                startDate: jobDate,
                endDate: normalizedEndDate,
                maxOccurrences,
                defaultWorkers: workerIds,
                createdBy: currentUserId,
            });

            const generatedUntil = new Date(Date.now() + generateAheadDays * 24 * 60 * 60 * 1000);
            generatedJobs = await generateOccurrences(recurringJob, generatedUntil);

            if (workerIds.length && generatedJobs.length) {
                const allAssignments = generatedJobs.flatMap(job =>
                    workerIds.map((workerId, idx) => ({
                        job: job._id,
                        worker: workerId,
                        createdBy: currentUserId,
                        payRate: baseJobFields.payRate,
                        company: req.user.company_id,
                        fullname: realWorkers[idx].fullname
                    }))
                );
                // ordered:false so one duplicate doesn't abort the whole batch
                await JobAssignment.insertMany(allAssignments, { ordered: false });
            }
        } catch (err: any) {
            if (generatedJobs.length) {
                await Job.deleteMany({ _id: { $in: generatedJobs.map(j => j._id) } });
            }
            if (recurringJob) {
                await recurringJobModel.deleteOne({ _id: recurringJob._id });
            }
            if (templateJob) {
                await Job.deleteOne({ _id: templateJob._id });
            }

            if (err?.code === 11000) {
                throw new BadRequestError("This recurring schedule already exists for those dates.");
            }
            throw err;
        }

        await logActivity({ job: templateJob._id, type: "job_created", actor: currentUserId });
        if (workerIds.length && generatedJobs.length) {
            await Promise.all(
                generatedJobs.map(job =>
                    logActivity({
                        job: job._id,
                        type: "workers_assigned",
                        actor: currentUserId,
                        workers: workerIds,
                    })
                )
            );
        }

        res.status(StatusCodes.CREATED).json({
            success: true,
            recurringJob,
            templateJob,
            generatedJobs,
            generatedCount: generatedJobs.length,
        });
        return;
    }

    // ── One-off job ──────────────────────────────────────────────────────────

    const job = await Job.create({
        ...baseJobFields,
        status: "published",
    });

    await logActivity({ job: job._id, type: "job_created", actor: currentUserId });

    if (workerIds.length) {
        await JobAssignment.insertMany(
            workerIds.map((workerId, idx) => ({
                job: job._id,
                worker: workerId,
                createdBy: currentUserId,
                payRate: baseJobFields.payRate,
                company: req.user.company_id,
                fullname: realWorkers[idx].fullname || "testing her"
            }))
        );
        await logActivity({
            job: job._id,
            type: "workers_assigned",
            actor: currentUserId,
            workers: workerIds,
        });
    }

    res.status(StatusCodes.CREATED).json({ success: true, job });
};
export const getAllJobs: MiddlewareFn = async (
    req,
    res
): Promise<void> => {
    const {
        search,
        status,
        priority,
        sort = "newest",
        page = "1", limit: limitQuery = "100",
    } = req.query;
    const limit = Number(limitQuery) || 10;

    const query: Record<string, unknown> = {
        isDeleted: false,
        // createdBy: req.user.user_id
        company: req.user.company_id
    };

    if (search) {
        query.title = {
            $regex: search,
            $options: "i",
        };
    }

    if (status && status !== "all") {
        query.status = status;
    }

    if (priority && priority !== "all") {
        query.priority = priority;
    }

    const sortOptions: Record<string, string> = {
        newest: "-createdAt",
        oldest: "createdAt",
        a_z: "title",
        z_a: "-title",
    };

    const currentPage = Number(page);
    const skip = (currentPage - 1) * limit;

    let jobs = await Job.find(query)
        // .populate("workers", "fullname email")
        .sort(sortOptions[sort as string] ?? "-createdAt")
        .skip(skip)
        .limit(limit);

    const assignments = await JobAssignment.find({
        createdBy: getReqUser(req).user_id,
        job: {
            $in: jobs.map(job => job._id),
        },
    });


    const assignmentMap = assignments.reduce((acc, assignment) => {
        // console.log("assignment :", assignment,)
        const key = assignment.job.toString();

        if (!acc[key]) {
            acc[key] = [];
        }

        acc[key].push(assignment);

        return acc;
    }, {} as Record<string, typeof assignments>);
    const result = jobs.map(job => ({
        ...job.toObject(),
        workers: assignmentMap[job._id.toString()] ?? [],
    }));
    // console.log("this is the result : ", result.map(r => r.workers))

    const totalJobs = await Job.countDocuments(query);
    res.status(StatusCodes.OK).json({
        success: true,
        jobs: result,
        totalJobs,
        totalPages: Math.ceil(totalJobs / limit),
        currentPage,
    });
};
export const getJob: MiddlewareFn = async (
    req,
    res
): Promise<void> => {
    const job = await Job.findOne({
        _id: req.params.id,
        isDeleted: false
        // companyId: getReqUser(req).companyId,
    })
    const assignment = await JobAssignment.find({
        job: req.params.id,
    }).populate("worker", "fullname email");


    if (!job) throw new NotFoundError("job not found ")

    res.status(StatusCodes.OK).json({
        success: true,
        job: {
            ...job.toObject(),
            workers: assignment
        },
    });
};
export const updateJob: MiddlewareFn = async (req, res) => {
    const { startTime, endTime } = req.body;

    if (!startTime || !endTime) {
        throw new BadRequestError("Start time and end time are required.");
    }

    const workers = JSON.parse(req.body.workers ?? "[]");

    const workerEmails = workers.map((w: any) => w.email);

    /**
     * Find all selected workers
     */
    const selectedUsers = await userModel.find({
        email: {
            $in: workerEmails,
        },
    });

    /**
     * Current assignments
     */
    const currentAssignments = await JobAssignment.find({
        job: req.params.id,
    });


    const selectedWorkerIds = selectedUsers.map((u) => u._id.toString());

    const currentWorkerIds = currentAssignments.map((a) =>
        a.worker.toString()
    );

    /**
     * Workers to remove
     */
    const assignmentsToRemove = currentAssignments.filter(
        (assignment) =>
            !selectedWorkerIds.includes(assignment.worker.toString())
    );

    if (assignmentsToRemove.length > 0) {
        await JobAssignment.deleteMany({
            _id: {
                $in: assignmentsToRemove.map((a) => a._id),
            },
        });
    }

    /**
     * Workers to add
     */
    const usersToAssign = selectedUsers.filter(
        (user) => !currentWorkerIds.includes(user._id.toString())
    );

    if (usersToAssign.length > 0) {
        await JobAssignment.insertMany(
            usersToAssign.map((user) => ({
                job: req.params.id,
                worker: user._id,
                createdBy: getReqUser(req).user_id,
                fullname: user.fullname,
                email: user.email,
            }))
        );
    }


    /**
     * Update job
     */
    const job = await Job.findByIdAndUpdate(
        req.params.id,
        {
            ...req.body,
            client: "client",
            minutes: jobDurationMinutes(startTime, endTime),
        },
        {
            new: true,
            runValidators: true,
        }
    );

    if (!job) {
        throw new BadRequestError("Job not found.");
    }
    await logActivity({
        job: job._id,
        type: "workers_assigned",
        actor: getReqUser(req).user_id,
        workers: usersToAssign.map((u) => u._id),
    });
    /**
     * Return updated job with assignments
     */
    const assignments = await JobAssignment.find({
        job: job._id,
    }).populate("worker", "fullname email");

    res.status(StatusCodes.OK).json({
        success: true,
        job,
        assignments,
    });
};
export const deleteJob: MiddlewareFn = async (req, res): Promise<void> => {

    const job = await Job.findOneAndUpdate(
        { _id: req.params.id, isDeleted: false }, // don't "delete" an already-deleted job
        { isDeleted: true },
        { new: true }
    );

    if (!job) {
        throw new BadRequestError(`Could not find job with id ${req.params.id}`);
    }
    // await logActivity("")
    res.status(StatusCodes.OK).json({
        success: true,
        message: "Job deleted successfully",
    });
};