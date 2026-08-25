import { NextFunction, Request, Response } from "express";

export const paginationMiddleware = (
  req: Request & { pagination?: any },
  res: Response,
  next: NextFunction
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
