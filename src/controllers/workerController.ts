import { StatusCodes } from "http-status-codes";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import userModel from "../models/userModel.js";
import { hashPassword } from "../utils/passwordUtils.js";
import jobModel from "../models/jobModel.js";

export const createWorker: MiddlewareFn = async (req, res) => {
    const { fullname, email, password } = req.body;

    // req.user should come from your auth middleware
    const currentUser = req.user;

    if (!currentUser) {
        return res
            .status(StatusCodes.UNAUTHORIZED)
            .json({ message: "Unauthorized" });
    }

    if (!["admin", "manager"].includes(currentUser.role)) {
        return res
            .status(StatusCodes.FORBIDDEN)
            .json({ message: "You are not allowed to create workers." });
    }

    const existingUser = await userModel.findOne({
        email: email.toLowerCase(),
    });

    if (existingUser) {
        return res
            .status(StatusCodes.BAD_REQUEST)
            .json({ message: "Email already exists." });
    }
    const hashedPassword = await hashPassword(password);
    const created_by_user = await userModel.findOne({
        _id: req?.user?.user_id
    })

    const worker = await userModel.create({
        fullname,
        email: email.toLowerCase(),
        password: hashedPassword,
        role: "worker",
        createdBy: currentUser.user_id,
        company: created_by_user?.company || "no company "

    });

    res.status(StatusCodes.CREATED).json({
        message: "Worker created successfully.",
        worker,
    });
};
export const getMyJobs: MiddlewareFn = async (req, res) => {
    const workerId = req.user.user_id;
    const all = await jobModel.find({
    }).sort({
        startDate: 1,
    })
    console.log("wordid : ", workerId,
        all.map(a => a.workers)
    )
    const jobs = await jobModel.find({
        "workers.user": workerId,
    }).sort({
        startDate: 1,
    });
    console.log("Jobs : ", jobs)

    res.status(StatusCodes.OK).json({
        jobs,
        totalPages: jobs.length,
    });
};
export const getJob :MiddlewareFn  = async (req, res) => {
  const { id } = req.params;

  const job = await jobModel.findOne({
    _id: id,
    "workers.user": req.user.user_id,
  });

  if (!job) {
    throw new NotFoundError("Job not found");
  }

  res.status(StatusCodes.OK).json(job);
};