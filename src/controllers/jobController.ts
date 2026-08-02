import { StatusCodes } from "http-status-codes";
import Job from "../models/jobModel.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import userModel from "../models/userModel.js";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import JobAssignment from "../models/JobAssignment.js";
import Company from "../models/company.js";
import dayjs from "dayjs";
import { logActivity } from "../utils/logActivity.js";

export const createJob: MiddlewareFn = async (
    req,
    res
): Promise<void> => {


    const { startTime, endTime } = req.body
    if (!startTime || !endTime) throw new BadRequestError("start or end time required")
    let workers: any[] = JSON.parse(req.body.workers)
    console.log("data from the body :", workers)
    workers = workers.map(w => w.email)

    const realWorkers = await userModel.find({
        email: { $in: workers },
    });
    const formattedWorkers = realWorkers.map(worker => ({
        user: worker._id,
        fullname: worker.fullname,
        email: worker.email,
        // phone: worker.phone ?? "",
    }));

    const [sh, sm] = startTime.split(':').map(Number)
    const [eh, em] = endTime.split(':').map(Number)
    const mins = (eh * 60 + em) - (sh * 60 + sm)
    const h = Math.floor(Math.abs(mins) / 60)
    const m = Math.abs(mins) % 60
    //     const today = dayjs().format("YYYY-MM-DD");

    //   const scheduledStart = dayjs(`${today} ${startTime}`);
    let companId;
    let isAdmin: any = req.user.role === "admin";
    let company;
    if (isAdmin) {
        company = await Company.findOne({ owner: req.user.user_id });
    } else {
        const currentUser = await userModel.findOne({ _id: req.user.user_id });
        const createdByUser = await userModel.findOne({ _id: currentUser?.createdBy });
        if (!createdByUser) throw new NotFoundError("could not find the user who created this worker")
        company = await Company.findOne({ owner: createdByUser._id });
    }


    const job = await Job.create({
        ...req.body,
        hours: m,
        createdBy: req.user.user_id,
        status: "published",
        client: req.body.company,
        company: req.body.company,
    });
    const assignments = formattedWorkers.map(worker => ({
        job: job._id,
        worker: worker.user,
        createdBy: req.user.user_id,
        fullname: worker.fullname,
        email: worker.email
    }));

    await logActivity({ job: job._id, type: "job_created", actor: req.user.user_id });
    await logActivity({
        job: job._id,
        type: "workers_assigned",
        actor: req.user.user_id,
        workers: formattedWorkers.map(w => w.user),
    });
    await JobAssignment.insertMany(assignments);

    res.status(StatusCodes.CREATED).json({
        success: true,
        job: [],
    });
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
        page = "1", limit = 10,
    } = req.query;

    const query: Record<string, unknown> = {
        // companyId: req.user.companyId,.
        // createdBy: req.user.user_id
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
        createdBy: req.user.user_id,
        job: {
            $in: jobs.map(job => job._id),
        },
    });


    const assignmentMap = assignments.reduce((acc, assignment) => {
        console.log("assignment :", assignment,)
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
    console.log("this is the result : ", result.map(r => r.workers))
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
        // companyId: req.user.companyId,
    })
    const assignment = await JobAssignment.find({
        job: req.params.id,
    }).populate("worker", "fullname email");
    const assignment_without_query = await JobAssignment.find({
        job: req.params.id,
    }).populate("worker", "fullname email");
    console.log("assignment with query :", assignment)
    console.log("assignment without query :", assignment_without_query)
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

    console.log("current assignments :", currentAssignments);

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
                createdBy: req.user.user_id,
                fullname: user.fullname,
                email: user.email,
            }))
        );
    }

    /**
     * Calculate hours
     */
    const [sh, sm] = startTime.split(":").map(Number);
    const [eh, em] = endTime.split(":").map(Number);

    const totalMinutes = eh * 60 + em - (sh * 60 + sm);

    const hours = Math.floor(Math.abs(totalMinutes) / 60);
    const minutes = Math.abs(totalMinutes) % 60;

    /**
     * Update job
     */
    const job = await Job.findByIdAndUpdate(
        req.params.id,
        {
            ...req.body,
            client: "client",
            hours: minutes,
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
        actor: req.user.user_id,
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
export const deleteJob: MiddlewareFn = async (
    req,
    res
): Promise<void> => {
    const job = await Job.findOneAndDelete({
        _id: req.params.id,
        companyId: req.user.companyId,
    });

    if (!job) {
        throw new BadRequestError("couldnot find job with " + req.params.id,)
    }

    res.status(StatusCodes.OK).json({
        success: true,
        message: "Job deleted successfully",
    });
};