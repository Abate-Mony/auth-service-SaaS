import cloudinary from "cloudinary";
import { StatusCodes } from "http-status-codes";
import {
  BadRequestError,
  UnauthenticatedError,
} from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import { formatImage } from "../middleware/multerMiddleware.js";
import logisticModel from "../models/logisticModel.js";
import userModel from "../models/userModel.js";
import { generateUniqueCharacter } from "../utils/generateRandomNumbers.js";
import day from "dayjs";
import mongoose from "mongoose";
import { USER_ROLES } from "../utils/constant.js";

export const createLogistic: MiddlewareFn = async (req, res) => {
  const { userId, role } = req.user;
  const user = await userModel.findOne({
    userId,
  });
  if (!user /*|| role === USER_ROLES.admin*/)
    throw new UnauthenticatedError(`unauthenticated error`);
  const { name } = user;
  req.body.tracking_number = await generateUniqueCharacter({
    Model: logisticModel,
    type: "number",
    length: 10,
  });
  req.body.createdBy = {
    userId,
    user: name,
  };
  // console.log("thisisiis ", req.body);
  const descriptions: {
    name?: string;
    imgUrl: string;
    avatarPublicId?: string;
  }[] = [];
  const { text } = req.body;
  const isString = typeof text == "string";
  if (req.files) {
    const files = req.files;
    for (let i = 0; i < files.length; ++i) {
      const file = files[i];
      const _file = formatImage(file);
      try {
        const response = await cloudinary.v2.uploader.upload(_file);
        const desc: { name?: string; imgUrl: string; avatarPublicId?: string } =
          {
            imgUrl: response.secure_url,
            avatarPublicId: response.public_id,
            name: isString ? text : text[i],
          };
        console.log("desc", desc);
        descriptions.push(desc);
      } catch (err) {
        console.log("this is th error her ", err);
      }
    }
    // files.forEach(async (file: File, idx: number) => {
    //   const _file = formatImage(file);
    //   try {
    //     const response = await cloudinary.v2.uploader.upload(_file);
    //     const desc: { name?: string; imgUrl: string; avatarPublicId?: string } =
    //       {
    //         imgUrl: response.secure_url,
    //         avatarPublicId: response.public_id,
    //         name: isString ? text : text[idx],
    //       };
    //     console.log("desc", desc);
    //     descriptions.push(desc);
    //   } catch (err) {
    //     console.log("this is th error her ", err);
    //   }
    //   // const desc: { name?: string; imgUrl: string; avatarPublicId?: string } = {
    //   //   imgUrl: `some${idx}`,
    //   //   avatarPublicId: String(idx),
    //   //   name: isString ? text : text[idx],
    //   // };

    //   // newUser.avatar = response.secure_url;
    //   // newUser.avatarPublicId = response.public_id;
    //   // console.log("this is the ", _file);
    // });
    // console.log("descriptions here", descriptions);
  }
  // const logistic = true;
  console.log("description here", descriptions);
  req.body.descriptions = descriptions;
  const logistic = await logisticModel.create(req.body);
  if (!logistic)
    throw new BadRequestError(`fail to create product something went wrong `);
  res.status(StatusCodes.CREATED).json({ logistic });
};

export const getStaticLogistic: MiddlewareFn = async (req, res) => {
  let numbers = req.query.tracking_numbers;
  let f_number = [];
  if (numbers) {
    numbers.split(",").forEach((num) => f_number.push(num));
  } else {
    throw new BadRequestError(`sorry bad happen`);
  }

  // const id = req.params.id;
  console.log("tracking numbers", numbers, f_number, req.query);
  const logistics = await logisticModel.find({
    tracking_number: {
      $in: [...f_number],
    },
  });
  if (logistics.length == 0)
    throw new BadRequestError(
      `couldnot get  the logistic with id ${f_number.join(" ")}`
    );
  res.status(StatusCodes.OK).json({
    logistics,
  });
};
export const getLogistics: MiddlewareFn = async (req, res) => {
  const { userId, role } = req.user;
  const { search, status } = req.query;

  let _user_id: number | null = null;
  if (role == USER_ROLES.admin && req.query.userId) {
    //admin requesting info
    _user_id = req.query.userId;
  } else {
    //user requesting info
    _user_id = userId;
  }

  const queryObject: any = {
    "createdBy.userId": _user_id,
  };
  if (search) {
    queryObject.$or = [
      {
        name: { $regex: search, $options: "i" },
      },
      // {
      //   email: { $regex: search, $options: "i" },
      // },
    ];
    // console.log(Number(search))
  }
  // const page = Number(req.query.page) || 1;
  // const limit = Number(req.query.limit) || 20;
  // const skip = (page - 1) * limit;
  if (status && status !== "all") {
    queryObject.status = status;
  }

  const { page, limit, skip, nPages } = req.pagination;
  const logistics = await logisticModel
    .find({ ...queryObject })
    .skip(skip)
    .limit(limit);
  const totalLogististics = await logisticModel.countDocuments(queryObject);
  // const numberOfPage = Math.ceil(totalLogististics / limit);
  const numberOfPage = nPages(totalLogististics);
  res
    .json({
      logistics,
      nHits: totalLogististics,
      numberOfPage,
      limit,
      currentPage: page,
    })
    .status(StatusCodes.OK);
};
export const deleteLogistic: MiddlewareFn = async (req, res) => {
  const id = req.params.id;
  const logistic = await logisticModel.findOneAndDelete({
    tracking_number: id,
  });
  //   something happen and fail to delete the logistic
  // throws and error to the user trying to delete the logistic
  if (!logistic)
    throw new BadRequestError(`fail to delete logistic with ${id}`);
  res.status(StatusCodes.CREATED).json({ msg: "success" });
};

export const updateLogistic: MiddlewareFn = async (req, res) => {
  // const {} = req.body;
  const tracking_number = req.params.tracking_number;

  const logistic = await logisticModel.findOneAndUpdate(
    {
      tracking_number,
    },
    {
      ...req.body,
    }
  );
  if (!logistic) throw new BadRequestError("fal to update logistic with id");
  res.status(StatusCodes.OK).json({
    success: true,
  });
};
export const showStats = async (req, res) => {
  const { userId, role } = req.user;
  let _user_id: number | null = null;
  
  if (role == USER_ROLES.admin && req.query.userId) {
    console.log("enter here", req.query.userId,userId);
    //admin requesting info
    _user_id = Number(req.query.userId);
  } else {
    //user requesting info
    _user_id = userId;
  }
console.log("_user_id outsie",_user_id)
  // const queryObject: any = {
  //   "createdBy.userId": _user_id,
  // };
  const total = await logisticModel.countDocuments({
    "createdBy.userId": _user_id,
  });
  let stats: any = await logisticModel.aggregate([
    { $match: { "createdBy.userId": _user_id } },
    {
      $group: {
        _id: "$status",

        count: { $sum: 1 },
      },
    },
  ]);
  console.log("this is the user query here ,", stats);
  stats = stats.reduce((acc, curr) => {
    const { _id: title, count } = curr;
    acc[title] = count;
    return acc;
  }, {});
  // stats=stat.reduce

  console.log("this is the reduce stat here", stats, "total", total);

  const defaultStats = {
    pending: stats.pending || 0,
    recieved: stats.recieved || 0,
    sent: stats.sent || 0,
  };
  // console.log(defaultStats, "default stats");

  // let monthlyApplications = await Job.aggregate([
  //   { $match: { createdBy: new mongoose.Types.ObjectId(req.user.userId) } },
  //   {
  //     $group: {
  //       _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
  //       count: { $sum: 1 },
  //     },
  //   },
  //   { $sort: { "_id.year": -1, "_id.month": -1 } },
  //   { $limit: 6 },
  // ]);
  // console.log("this  multiplication stats here", monthlyApplications);

  // monthlyApplications = monthlyApplications
  //   .map((item) => {
  //     const {
  //       _id: { year, month },
  //       count,
  //     } = item;

  //     const date = day()
  //       .month(month - 1)
  //       .year(year)
  //       .format("MMM YY");

  //     return { date, count };
  //   })
  //   .reverse();
  // console.log("this is the multiplicatio data here", monthlyApplications);

  res.status(StatusCodes.OK).json({
    defaultStats,
    nHits: total,
  });
};
