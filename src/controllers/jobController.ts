import { StatusCodes } from "http-status-codes";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { MiddlewareFn, getReqUser } from "../interfaces/expresstype.js";
import JobAssignment from "../models/JobAssignment.js";
import Job from "../models/jobModel.js";
import Company from "../models/company.js";
import recurringJobModel from "../models/recurringJobModel.js";
import userModel from "../models/userModel.js";
import { toUtcDay } from "../utils/dates.js";
import { generateOccurrences } from "../utils/generateOccurrences.js";
import { logActivity } from "../utils/logActivity.js";
import { sendShiftAssigned, sendRecurringShiftAssigned } from "../utils/mailTemplates.js";
import { sendPushToUser } from "../utils/webPush.js";
import dayjs from "../utils/dayjsSetup.js";
import { TZ } from "../utils/dates.js";

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

// Plain-English recurrence description for the "added to a recurring shift"
// notification — e.g. "Every week on Mon, Wed" or "Every 2 days".
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const describeRecurrence = (
    frequency: string,
    intervalNum: number,
    daysOfWeek?: number[]
): string => {
    if (frequency === "daily") {
        return intervalNum === 1 ? "Every day" : `Every ${intervalNum} days`;
    }
    if (frequency === "weekly") {
        const days = [...(daysOfWeek ?? [])].sort().map(d => DAY_NAMES[d]).join(", ");
        return intervalNum === 1 ? `Every week on ${days}` : `Every ${intervalNum} weeks on ${days}`;
    }
    return intervalNum === 1 ? "Every month" : `Every ${intervalNum} months`;
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
        generateAheadDays,
          geofenceMode,
         geofenceRadiusMeters,
         clockInGraceMinutes
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
            console.log("this is the workers : ", workers)
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
    console.log("requested_user body", req.body)
//      geofenceMode: 'enforce',
// [1]   geofenceRadiusMeters: 150,
    const baseJobFields = {
        title,
        description,
        company: req.user.company_id.toString(),
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
         geofenceMode,
         geofenceRadiusMeters,
         clockInGraceMinutes
    };
    // throw new BadRequestError("testing")

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
                company: req.user.company_id,
            });

            let effectiveGenerateAheadDays = generateAheadDays;
            if (effectiveGenerateAheadDays === undefined) {
                const company = await Company.findById(req.user.company_id).select("generateAheadDays").lean();
                effectiveGenerateAheadDays = company?.generateAheadDays ?? 30;
            }
            const generatedUntil = new Date(Date.now() + effectiveGenerateAheadDays * 24 * 60 * 60 * 1000);
            // generateOccurrences assigns recurringJob.defaultWorkers (== workerIds,
            // set above) to every job it creates — no separate assignment step
            // needed here.
            generatedJobs = await generateOccurrences(recurringJob, generatedUntil);
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

            // One summary notification per worker, not one per occurrence —
            // a weekly schedule can generate dozens of jobs in one request,
            // and nobody wants that many pushes at once for a single action.
            const occurrenceDates = generatedJobs.map(j => j.date.getTime()).sort((a, b) => a - b);
            const firstDate = new Date(occurrenceDates[0]);
            const lastDate = new Date(occurrenceDates[occurrenceDates.length - 1]);
            const daysLabel = describeRecurrence(frequency, intervalNum, normalizedDaysOfWeek);

            Promise.all(
                realWorkers.map(w =>
                    Promise.all([
                        sendRecurringShiftAssigned({
                            worker: { email: w.email, fullname: w.fullname },
                            job: {
                                _id: templateJob._id.toString(),
                                title: templateJob.title,
                                location: templateJob.location,
                                address: templateJob.address,
                                date: jobDate,
                                startTime: templateJob.startTime,
                                endTime: templateJob.endTime,
                                minutes: templateJob.minutes,
                            },
                            occurrenceCount: generatedJobs.length,
                            firstDate,
                            lastDate,
                            daysLabel,
                        }),
                        sendPushToUser(w._id.toString(), {
                            title: "Added to a recurring shift",
                            body: `${templateJob.title} — ${daysLabel}, ${generatedJobs.length} shifts scheduled`,
                            tag: `recurring-assigned-${recurringJob._id}`,
                            url: "/worker/jobs",
                        }),
                    ])
                )
            ).catch(err => console.error(`Failed to send recurring shift-assigned notification(s) for recurringJob ${recurringJob._id}:`, err));
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
    // Fire-and-forget: the client doesn't need to wait on outbound mail/push,
    // and a failed send shouldn't fail job creation.
    Promise.all(
        realWorkers.map(w =>
            Promise.all([
                sendShiftAssigned({
                    worker: { email: w.email, fullname: w.fullname },
                    job: {
                        _id: job._id.toString(),
                        title: job.title,
                        location: job.location,
                        address: job.address,
                        date: job.date,
                        startTime: job.startTime,
                        endTime: job.endTime,
                        minutes: job.minutes,
                    },
                }),
                // Tagged per job (distinct from the shift-start-reminder tag
                // namespace) so re-saving/updating doesn't stack duplicates.
                sendPushToUser(w._id.toString(), {
                    title: "New shift assigned",
                    body: `${job.title} — ${dayjs(job.date).tz(TZ).format("ddd D MMM")}, ${job.startTime} at ${job.location}`,
                    tag: `shift-assigned-${job._id}`,
                    url: `/worker/jobs/${job._id}`,
                }),
            ])
        )
    ).catch(err => console.error(`Failed to send shift-assigned notification(s) for job ${job._id}:`, err));

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
        client,
        unassigned
    } = req.query;
    const limit = Number(limitQuery) || 10;

    const query: Record<string, unknown> = {
        isDeleted: false,
        // createdBy: req.user.user_id
        company: req.user.company_id
    };
    if (unassigned && unassigned !== "false") {
        // Jobs with zero active assignments — exclude any job id that has
        // at least one non-deleted JobAssignment linked to it.
        const assignedJobIds = await JobAssignment.distinct("job", { isDeleted: false });
        query._id = { $nin: assignedJobIds };
    }
    if (client) {
        query.client = {
            $regex: client,
            $options: "i",
        }
    }
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
        job: {
            $in: jobs.map(job => job._id),
        },
        isDeleted: false,
    }).populate("worker", "fullname email worker").lean();

    // Flatten the populated worker onto the assignment — same shape as
    // getJob returns: { fullname, email, ... } directly, no nested `worker`.
    const flatAssignments = assignments.map(({ worker, ...rest }) => ({
        ...rest,
        email: (worker as any)?.email,
        worker: (worker as any)?._id,
    }));

    // console.log("flat-worker",assignments)
    const assignmentMap = flatAssignments.reduce((acc, assignment) => {
        const key = assignment.job.toString();

        if (!acc[key]) {
            acc[key] = [];
        }

        acc[key].push(assignment);

        return acc;
    }, {} as Record<string, typeof flatAssignments>);
    const result = jobs.map(job => ({
        ...job.toObject(),
        workers: assignmentMap[job._id.toString()] ?? [],
    }));
    // console.log("this is the result : ", result.map(r => r.workers))
    console.log("jobs", result)
    const totalJobs = await Job.countDocuments(query);
    res.status(StatusCodes.OK).json({
        success: true,
        jobs: result,
        totalJobs,
        totalPages: Math.ceil(totalJobs / limit),
        currentPage,
    });
};
export const duplicateJob: MiddlewareFn = async (req, res) => {
    const { id } = req.params;

    const job = await Job.findOne({ _id: id, isDeleted: false });

    if (!job) {
        throw new BadRequestError("Cannot find job with this id");
    }

    const jobData = job.toObject() as Record<string, any>;

    delete jobData._id;
    delete jobData.createdAt;
    delete jobData.updatedAt;
    delete jobData.__v;

    const duplicatedJob = await Job.create({
        ...jobData,

        // Optional: make it obvious this is a duplicate
        title: `${jobData.title} (Copy)`,

        // Usually safer to reset these
        status: "draft",
        // isPublished: false,

        // A duplicate stands alone — it isn't an occurrence of the source
        // job's recurring series. Keeping recurringJob would also collide
        // with the unique (recurringJob, date) index since the date matches.
        recurringJob: null,
        isTemplate: false,

        // Current user becomes creator
        createdBy: req.user.user_id,
    });

    const jobAssignments = await JobAssignment.find({ job: job._id, isDeleted: false });

    if (jobAssignments.length) {
        await JobAssignment.insertMany(
            jobAssignments.map((ja) => ({
                // New assignment for a fresh draft job — none of the
                // source's accept/decline/check-in history applies here.
                job: duplicatedJob._id,
                worker: ja.worker,
                createdBy: req.user.user_id,
                payRate: ja.payRate,
                company: ja.company,
                fullname: ja.fullname,
            })),
            { ordered: false }
        );
    }

    res.status(StatusCodes.CREATED).json({
        success: true,
        msg: "Job duplicated successfully",
        job: duplicatedJob,
    });
};
export const getJob: MiddlewareFn = async (
    req,
    res
): Promise<void> => {
    const job = await Job.findOne({
        _id: req.params.id,
        isDeleted: false,

        // companyId: getReqUser(req).companyId,
    })
    const assignments = await JobAssignment.find({
        job: req.params.id,
        isDeleted: false,
    }).populate("worker", "fullname email").lean();

    if (!job) throw new NotFoundError("job not found ")

    // Flatten the populated worker onto the assignment itself — the caller
    // wants { fullname, email, ... } directly, not nested under `worker`.
    // `fullname` is already denormalised on the assignment; only `email`
    // actually needs pulling out of the populated doc.
    const workers = assignments.map(({ worker, ...rest }) => ({
        ...rest,
        email: (worker as any)?.email,
    }));
    console.log("this is workers : ", workers)

    res.status(StatusCodes.OK).json({
        success: true,
        job: {
            ...job.toObject(),
            workers,
        },
    });
};
const UPDATE_JOB_ALLOWED_FIELDS = [
    "title", "description", "client", "location", "address", "coordinates",
    "requiredWorkers", "priority", "supervisor", "payRate", "chargeRate",
    "notes", "instructions", "status","geofenceMode","geofenceRadiusMeters"
] as const;

export const updateJob: MiddlewareFn = async (req, res) => {
    const currentUserId = getReqUser(req).user_id;
    const companyId = getReqUser(req).company_id;

    const job = await Job.findOne({ _id: req.params.id, isDeleted: false });
    if (!job) {
        throw new BadRequestError("Job not found.");
    }

    // Both are optional on the request — a caller editing only e.g. workers
    // or notes shouldn't have to resend the existing shift time. Only a
    // request that actually tries to change one of them needs both present.
    const startTime = req.body.startTime ?? job.startTime;
    const endTime = req.body.endTime ?? job.endTime;

    if (!startTime || !endTime) {
        throw new BadRequestError("Start time and end time are required.");
    }

    // `workers` being entirely absent means "leave assignments alone" (e.g.
    // the caller is only editing the title) — an explicit [] is what clears
    // every assignment, never an omitted field.
    let usersToAssign: any[] = [];
  

        if (req.body.workers !== undefined) {
            console.log("this is the workers ", req.body.workers)
            let workers: any[];
            try {
                workers = typeof req.body.workers === "string" ? JSON.parse(req.body.workers) : req.body.workers;
            } catch {
                throw new BadRequestError("Invalid workers payload");
            }
            if (!Array.isArray(workers)) {
                throw new BadRequestError("Invalid workers payload");
            }

            // Accept either shape: a flat { email } (what createJob expects) or a
            // populated assignment's nested { worker: { email } } — the frontend
            // sends whichever it currently has on hand for each worker row.
            const workerEmails = workers
                .map((w: any) => w?.email ?? w?.worker?.email)
                .filter(Boolean);

            // A non-empty workers array that resolves to zero emails means the
            // payload shape wasn't recognised — never treat that as "unassign
            // everyone", which is what silently happened before this guard.
            if (workers.length > 0 && workerEmails.length === 0) {
                throw new BadRequestError("Invalid workers payload — each worker must include an email.");
            }

            const selectedUsers = workerEmails.length
                ? await userModel.find({ email: { $in: workerEmails }, isActive: true })
                : [];

            const foundEmails = new Set(selectedUsers.map(u => u.email));
            const missingEmails = workerEmails.filter(e => !foundEmails.has(e));
            if (missingEmails.length) {
                throw new BadRequestError(`No active account found for: ${missingEmails.join(", ")}`);
            }

            const currentAssignments = await JobAssignment.find({ job: job._id });
            const selectedWorkerIds = selectedUsers.map(u => u._id.toString());
            const currentWorkerIds = currentAssignments.map(a => a.worker.toString());

            const assignmentsToRemove = currentAssignments.filter(
                a => !selectedWorkerIds.includes(a.worker.toString())
            );
            usersToAssign = selectedUsers.filter(
                u => !currentWorkerIds.includes(u._id.toString())
            );
            // change it later to isdelted=true
            if (assignmentsToRemove.length) {
                await JobAssignment.updateMany(
                    { _id: { $in: assignmentsToRemove.map(a => a._id) } },
                    { isDeleted: true }
                );
            }

            if (usersToAssign.length) {
                await JobAssignment.insertMany(
                    usersToAssign.map(user => ({
                        job: job._id,
                        worker: user._id,
                        createdBy: currentUserId,
                        company: companyId,
                        payRate: req.body.payRate ?? job.payRate,
                        fullname: user.fullname,
                    }))
                );
            }
        }

    // Allowlisted — never spread req.body, or clients can set company/
    // createdBy/isDeleted/isTemplate/recurringJob directly.
    const updateFields: Record<string, any> = {
        startTime,
        endTime,
        minutes: jobDurationMinutes(startTime, endTime),
    };
    for (const key of UPDATE_JOB_ALLOWED_FIELDS) {
        if (req.body[key] !== undefined) updateFields[key] = req.body[key];
    }
    if (req.body.date !== undefined) {
        updateFields.date = toUtcDay(req.body.date);
    }

    const updatedJob = await Job.findByIdAndUpdate(job._id, updateFields, {
        new: true,
        runValidators: true,
    });

    if (!updatedJob) {
        throw new BadRequestError("Job not found.");
    }

    if (usersToAssign.length) {
        await logActivity({
            job: updatedJob._id,
            type: "workers_assigned",
            actor: currentUserId,
            workers: usersToAssign.map(u => u._id),
        });

        // Fire-and-forget, same as createJob — uses the just-updated job so a
        // manager who changes the time/location and adds workers in the same
        // request notifies with the final details, not the stale pre-update ones.
        Promise.all(
            usersToAssign.map(u =>
                Promise.all([
                    sendShiftAssigned({
                        worker: { email: u.email, fullname: u.fullname },
                        job: {
                            _id: updatedJob._id.toString(),
                            title: updatedJob.title,
                            location: updatedJob.location,
                            address: updatedJob.address,
                            date: updatedJob.date,
                            startTime: updatedJob.startTime,
                            endTime: updatedJob.endTime,
                            minutes: updatedJob.minutes,
                        },
                    }),
                    sendPushToUser(u._id.toString(), {
                        title: "New shift assigned",
                        body: `${updatedJob.title} — ${dayjs(updatedJob.date).tz(TZ).format("ddd D MMM")}, ${updatedJob.startTime} at ${updatedJob.location}`,
                        tag: `shift-assigned-${updatedJob._id}`,
                        url: `/worker/jobs/${updatedJob._id}`,
                    }),
                ])
            )
        ).catch(err => console.error(`Failed to send shift-assigned notification(s) for job ${updatedJob._id}:`, err));
    }

    /**
     * Return updated job with assignments
     */
    const assignments = await JobAssignment.find({
        job: updatedJob._id,
    }).populate("worker", "fullname email");

    res.status(StatusCodes.OK).json({
        success: true,
        job: updatedJob,
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

    await JobAssignment.updateMany({ job: job._id }, { isDeleted: true });
    // await logActivity("")
    res.status(StatusCodes.OK).json({
        success: true,
        message: "Job deleted successfully",
    });
};