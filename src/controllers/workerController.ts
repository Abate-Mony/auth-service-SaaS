import { StatusCodes } from "http-status-codes";
import mongoose from "mongoose";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { getReqUser, MiddlewareFn } from "../interfaces/expresstype.js";
import JobAssignment from "../models/JobAssignment.js";
import jobModel from "../models/jobModel.js";
import userModel from "../models/userModel.js";
import { hashPassword } from "../utils/passwordUtils.js";
import { logActivity } from "../utils/logActivity.js";
import recurringJobModel from "../models/recurringJobModel.js";
import dayjs from "dayjs";

export const createWorker: MiddlewareFn = async (req, res) => {
    const { fullname, email, password, role } = req.body;
    const currentUser = req.user;

    if (!currentUser) {
        res.status(StatusCodes.UNAUTHORIZED).json({ message: "Unauthorized" });
        return;
    }
    if (!["admin", "manager"].includes(currentUser.role)) {
        throw new BadRequestError("Only admins or managers can create workers.");
    }
    if (["admin"].includes(role)) {
        throw new BadRequestError("Invalid role. Only 'worker' role can be created.");
    }


    const existingUser = await userModel.findOne({ email: email.toLowerCase() });
    if (existingUser) {
        res.status(StatusCodes.BAD_REQUEST).json({ message: "Email already exists." });
        return;
    }

    const hashedPassword = await hashPassword(password);

    const worker = await userModel.create({
        fullname,
        email: email.toLowerCase(),
        password: hashedPassword,
        role: role,
        createdBy: currentUser.user_id,
        // company: currentUser.company ?? "6a6ec368b301e127831156a3", // pulled straight from req.user — no extra query needed
    });

    res.status(StatusCodes.CREATED).json({
        message: "Worker created successfully.",
        worker,
    });
};

export const getMyJobs: MiddlewareFn = async (req, res) => {
    const startTime=new Date()
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
            localField: "job",
            foreignField: "_id",
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

    // createdAt lives on the assignment doc, so sorting doesn't need the job
    // join. Without a search term we skip/limit BEFORE joining, so $lookup
    // only runs for the page (e.g. 20 docs) instead of every assignment the
    // worker has ever had. With a search term we still need the join first
    // since the filter depends on the joined job's title.
    const pipeline: mongoose.PipelineStage[] = search
        ? [
            { $match: assignmentMatch },
            { $sort: { createdAt: -1 as const } },
            lookupJob,
            unwindJob,
            { $match: { "job.title": { $regex: search, $options: "i" } } },
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
        ]
        : [
            { $match: assignmentMatch },
            { $sort: { createdAt: -1 as const } },
            {
                $facet: {
                    data: [
                        { $skip: (pageNum - 1) * limitNum },
                        { $limit: limitNum },
                        lookupJob,
                        unwindJob,
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
const time_querying=dayjs().diff(startTime,"seconds",true)
console.log("time quering is : ",time_querying)
    res.status(StatusCodes.OK).json({
        jobs,
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
    });
};

export const getJob: MiddlewareFn = async (req, res) => {
    const { id } = req.params;

    const [job, jobAssignment] = await Promise.all([
        jobModel.findOne({ _id: id }),
        JobAssignment.findOne({ job: id, worker: req.user.user_id }),
    ]);
    if (!job) {
        throw new BadRequestError("Job not found.");
    }

    const job_ = {
        ...job.toObject(),
        // Fall back to the job's own status when there's no assignment,
        // instead of misleadingly claiming "in-progress"
        status: jobAssignment?.status ?? job.status,
        workerJobDetails: jobAssignment || null,
    };

    res.status(StatusCodes.OK).json({
        job: job_,
        success: true,
    });
};

// Single source of truth for worker-driven status transitions.
// checkInJob below now just calls this instead of duplicating the logic.
export const updateWorkerJobStatus: MiddlewareFn = async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    const allowedStatuses = ["accepted", "declined", "in-progress", "completed"];
    if (!allowedStatuses.includes(status)) {
        throw new BadRequestError("Invalid status");
    }
    //PREVENT USER FROM STARTING A JOB IF THERE ARE ALREADY IN AN ACTIVE JOB 

    let assignment = await JobAssignment.findOne({
        worker: req.user.user_id,
        job: id,

    });

    if (!assignment) {
        throw new NotFoundError("You are not assigned to this job.");
    }
    if (status=="in-progress") {
        const hasActiveJob = await JobAssignment.exists({
            worker: req.user.user_id,
            status: "in-progress",
        });
        if (hasActiveJob) {
            throw new BadRequestError("You already have an active Job please complete the job to start another one ")
        }
    }
    // if(!assignment.ma)
    switch (status) {
        case "accepted":
            if (assignment.status !== "pending") {
                throw new BadRequestError(`You cannot accept a job that is ${assignment.status}.`);
            }
            assignment.status = "accepted";
            assignment.acceptedAt = new Date();
            await logActivity({
                job: assignment.job,
                assignment: assignment._id,
                type: "assignment_accepted",
                actor: req.user.user_id,
            });
            break;

        case "declined":
            if (assignment.status !== "pending") {
                throw new BadRequestError(`You cannot decline a job that is ${assignment.status}.`);
            }
            assignment.status = "declined";
            assignment.declinedAt = new Date();
            await logActivity({
                job: assignment.job,
                assignment: assignment._id,
                type: "assignment_declined",
                actor: req.user.user_id,
            });
            break;

        case "in-progress":
            if (assignment.status !== "accepted") {
                throw new BadRequestError("You must accept the job before starting it.");
            }
            if (assignment.checkedInAt) {
                throw new BadRequestError("You have already checked in.");
            }
            assignment.status = "in-progress";
            assignment.checkedInAt = new Date();
            await logActivity({
                job: assignment.job,
                assignment: assignment._id,
                type: "assignment_checked_in",
                actor: req.user.user_id,
            });
            break;

        case "completed":
            if (assignment.status !== "in-progress") {
                throw new BadRequestError("You must start the job before completing it.");
            }
            assignment.status = "completed";
            assignment.completedAt = new Date();
            assignment.checkedOutAt = new Date(); // now actually persisted
            // hoursWorked is no longer computed here — the pre("save") hook on
            // JobAssignment derives it from checkedInAt/checkedOutAt automatically
            await logActivity({
                job: assignment.job,
                assignment: assignment._id,
                type: "assignment_checked_out",
                actor: req.user.user_id,
            });
            break;
    }

    await assignment.save();

    res.status(StatusCodes.OK).json({
        success: true,
        message: `Job ${status} successfully.`,
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