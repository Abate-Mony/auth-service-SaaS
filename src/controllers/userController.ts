// @ts-ignore
import { StatusCodes } from "http-status-codes";
import { UnauthenticatedError } from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import userModel from "../models/userModel.js";
import { sanitizeUser } from "../utils/tokenUtils.js";

export const currentUser: MiddlewareFn = async (req, res) => {
  const { user_id, role } = req?.user;
  console.log("current user _id :", req.user)
  const user = await userModel.findOne({ _id: user_id });
  if (!user) throw new UnauthenticatedError(`login again `);
  let Iuser = sanitizeUser(user);
  Iuser = {
    ...Iuser,
  };
  // console.log("this is the login user", Iuser, user);
  res.status(StatusCodes.OK).json({ user: Iuser });
};
export const getAllUser: MiddlewareFn = async (
  req,
  res
): Promise<void> => {
  const { search } = req.query;
  const queryObject: any = {};
  queryObject.createdBy = req.user.user_id
  if (search) {
    const userSearch = [
      {
        fullname: { $regex: search, $options: "i" },
      },
      {
        email: { $regex: search, $options: "i" },
      },
    ];
    // console.log(Number(search))

    queryObject.$or = [...userSearch];
  }
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 20;
  const skip = (page - 1) * limit;
  // testing
  const totalUsers = await userModel.countDocuments(queryObject);
  const users = await userModel.find({
    ...queryObject

  })
  const numberOfPage = Math.ceil(totalUsers / limit);

  res.status(200).json({ users, numberOfPage, limit, currentPage: page, nHits: totalUsers });
};
export const getStaticUser: MiddlewareFn = async (req, res) => {
  const user_id = req.params.userId;
  const user = await userModel.findOne({ _id: user_id });
  if (!user)
    throw new UnauthenticatedError(`
  couldnot found user with id ${user_id}
  `);
  let Iuser = sanitizeUser(user);
  Iuser = {
    ...Iuser,
    fullname: Iuser.name,
  };
  // console.log("this is the login user", Iuser, user);
  res.status(StatusCodes.OK).json({ user: Iuser });
};
