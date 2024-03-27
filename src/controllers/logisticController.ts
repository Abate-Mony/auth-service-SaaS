import { StatusCodes } from "http-status-codes";
import {
  BadRequestError,
  UnauthenticatedError,
} from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import logisticModel from "../models/logisticModel.js";
import userModel from "../models/userModel.js";
import { USER_ROLES } from "../utils/constant.js";
import { generateUniqueCharacter } from "../utils/generateRandomNumbers.js";
import { formatImage } from "../middleware/multerMiddleware.js";
import cloudinary from "cloudinary";
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
  let numbers = req.query.tracking_numbers ;
  let f_number = [];
  if (numbers) {
    numbers.split(",").forEach((num) => f_number.push(num));
  } else {
    throw new BadRequestError(`sorry bad happen`);
  }

  // const id = req.params.id;
  console.log("tracking numbers", numbers, f_number,req.query);
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
    logistics
  });
};
export const getLogistics: MiddlewareFn = async (req, res) => {
  const { userId, role } = req.user;
  const queryObject: any = {};
  // if (role != USER_ROLES.admin) {
  //   queryObject.createdBy = 4;
  // }
  //   more calculation later in the code
  const logistics = await logisticModel.find({ ...queryObject });
  res.json({ logistics }).status(StatusCodes.OK);
};
export const deleteLogistic: MiddlewareFn = async (req, res) => {
  const id = req.params.id;
  const logistic = await userModel.findOneAndDelete({ _id: id });
  //   something happen and fail to delete the logistic
  // throws and error to the user trying to delete the logistic
  if (!logistic)
    throw new BadRequestError(`fail to delete logistic with ${id}`);
  res.status(StatusCodes.CREATED).json({ msg: "success" });
};
