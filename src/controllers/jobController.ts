import { StatusCodes } from "http-status-codes";
import Job from "../models/jobModel.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import userModel from "../models/userModel.js";
import { BadRequestError } from "../errors/customErrors.js";


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
    // console.log("workers :",realWorkers)
    const job = await Job.create({
        ...req.body,
        // companyId: req.user.companyId,
        workers: formattedWorkers,
        client: "client",
        hours: `${h}h ${m > 0 ? m + 'm' : ''}`,
        createdBy: req.user.user_id,
    });

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
        createdBy: req.user.user_id
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

    const jobs = await Job.find(query)
        .populate("workers", "fullname email")
        .sort(sortOptions[sort as string] ?? "-createdAt")
        .skip(skip)
        .limit(limit);

    const totalJobs = await Job.countDocuments(query);

    res.status(StatusCodes.OK).json({
        success: true,
        jobs,
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
        companyId: req.user.companyId,
    }).populate("workers");

    if (!job) {
        res.status(StatusCodes.NOT_FOUND).json({
            success: false,
            message: "Job not found",
        });
        return;
    }

    res.status(StatusCodes.OK).json({
        success: true,
        job,
    });
};
export const updateJob: MiddlewareFn = async (
    req,
    res
): Promise<void> => {
    console.log("data from the body :", req.body)
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
    console.log(
        "formatted users",
        realWorkers,
        realWorkers.map(w => ({
            _id: w._id.toString(),
            fullname: w.fullname,
            email: w.email,
        }))
    );
    const [sh, sm] = startTime.split(':').map(Number)
    const [eh, em] = endTime.split(':').map(Number)
    const mins = (eh * 60 + em) - (sh * 60 + sm)
    const h = Math.floor(Math.abs(mins) / 60)
    const m = Math.abs(mins) % 60
    // console.log("workers :",realWorkers)




    const job = await Job.findOneAndUpdate(
        {
            _id: req.params.id,
            companyId: req.user.companyId,
        },
        {
            ...req.body,
            // companyId: req.user.companyId,
            workers: formattedWorkers,
            client: "client",
            hours: `${h}h ${m > 0 ? m + 'm' : ''}`,
            createdBy: req.user.user_id,
        },
        {
            new: true,
            runValidators: true,
        }
    );

    if (!job) {
        res.status(StatusCodes.NOT_FOUND).json({
            success: false,
            message: "Job not found",
        });
        return;
    }

    res.status(StatusCodes.OK).json({
        success: true,
        job,
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
        res.status(StatusCodes.NOT_FOUND).json({
            success: false,
            message: "Job not found",
        });
        return;
    }

    res.status(StatusCodes.OK).json({
        success: true,
        message: "Job deleted successfully",
    });
};