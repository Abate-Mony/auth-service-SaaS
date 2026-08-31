import { StatusCodes } from "http-status-codes";

export class NotFoundError extends Error {
  statusCode: number;
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "NotFoundError";
    this.statusCode = StatusCodes.NOT_FOUND;
    this.code = code;
  }
}
export class BadRequestError extends Error {
  statusCode: number;
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "BadRequestError";
    this.statusCode = StatusCodes.BAD_REQUEST;
    this.code = code;
  }
}
export class UnauthenticatedError extends Error {
  statusCode: number;
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "UnauthenticatedError";
    this.statusCode = StatusCodes.UNAUTHORIZED;
    this.code = code;
  }
}
export class UnauthorizedError extends Error {
  statusCode: number;
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "UnauthorizedError";
    this.statusCode = StatusCodes.FORBIDDEN;
    this.code = code;
  }
}
export class ConflictError extends Error {
  statusCode: number;
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "ConflictError";
    this.statusCode = StatusCodes.CONFLICT;
    this.code = code;
  }
}
