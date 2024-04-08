import { Request } from "express-validator/src/base.js";

export const paginationMiddleware = (
  req: Request,
  res: Response,
  next: any
) => {
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 20;
  const skip = (page - 1) * limit;
  const nPages = (n: number) => Math.ceil(n / limit);
  req.pagination = {
    page,
    limit,
    skip,
    nPages,
  };
  next();
};
