import type { Request, Response } from "express";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import dayjs from "dayjs";
import JobAssignment from "../models/JobAssignment.js";
import { BadRequestError, NotFoundError, UnauthorizedError } from "../errors/customErrors.js";
import { StatusCodes } from "http-status-codes";
import userModel from "../models/userModel.js";
import Company from "../models/company.js";
import { generateTimesheetPdf, TimesheetPdfRow } from "../utils/timesheetPdf.js";

type Period = "weekly" | "biweekly" | "monthly";

const getPeriodRange = (period: Period) => {
  const now = dayjs();

  switch (period) {
    case "weekly": {
      const start = now.startOf("week");
      const end = start.add(1, "week");

      return {
        start: start.toDate(),
        end: end.toDate(),
      };
    }

    case "biweekly": {
      const start = now.startOf("week");
      const end = start.add(2, "week");

      return {
        start: start.toDate(),
        end: end.toDate(),
      };
    }

    case "monthly": {
      const start = now.startOf("month");
      const end = start.add(1, "month");

      return {
        start: start.toDate(),
        end: end.toDate(),
      };
    }
  }
};
const ALLOWED_PERIODS: Period[] = ["weekly", "biweekly", "monthly"];

// A completed shift's payable minutes — approvedMinutes when a manager has
// signed off on it (caps an over-running shift until they do), otherwise the
// raw checked-in→checked-out time net of breaks.
const payableMinutesOf = (assignment: {
  approvedMinutes?: number | null;
  checkedInAt?: Date | null;
  checkedOutAt?: Date | null;
  breaks?: { startedAt?: Date | null; endedAt?: Date | null }[];
}): number => {
  if (assignment.approvedMinutes != null) return assignment.approvedMinutes;
  if (!assignment.checkedInAt || !assignment.checkedOutAt) return 0;

  const grossMinutes = dayjs(assignment.checkedOutAt).diff(dayjs(assignment.checkedInAt), "minute");
  const breakMinutes = (assignment.breaks ?? []).reduce((sum, b) => {
    if (!b.startedAt || !b.endedAt) return sum;
    return sum + dayjs(b.endedAt).diff(dayjs(b.startedAt), "minute");
  }, 0);

  return Math.max(0, grossMinutes - breakMinutes);
};

// Shared by the worker's own timesheet summary and the admin/manager
// "view a worker's timesheet" summary below — same numbers, same shape,
// just whichever worker id it's called with.
//
// `range` lets a caller who already knows exactly which days they want
// (the frontend's own period-paging math, e.g. "the biweekly block from
// 12 Aug") override the default "this period, right now" window — without
// it, a request for last week's timesheet would silently come back with
// this week's numbers instead.
const buildTimesheetSummary = async (
  workerId: string,
  period: Period,
  range?: { start: Date; end: Date }
) => {
  const { start, end } = range ?? getPeriodRange(period);

  const assignments = await JobAssignment.find({
    worker: workerId,
    status: "completed",
    isDeleted: false,
    checkedInAt: { $gte: start, $lt: end },
  })
    .populate<{ job: { title: string; date: Date; startTime: string; endTime: string } | null }>(
      "job",
      "title date startTime endTime"
    )
    .sort({ checkedInAt: 1 })
    .lean();

  let totalMinutes = 0;
  const rows = assignments.map(a => {
    const minutes = payableMinutesOf(a);
    totalMinutes += minutes;
    return {
      _id: a._id,
      title: a.job?.title ?? "Shift",
      date: a.job?.date ?? a.checkedInAt,
      startTime: a.job?.startTime ?? null,
      endTime: a.job?.endTime ?? null,
      minutes,
    };
  });

  return {
    start,
    end,
    summary: {
      totalJobs: assignments.length,
      shiftsCount: assignments.length,
      hasData: assignments.length > 0,
      totalMinutes,
      totalHours: Number((totalMinutes / 60).toFixed(2)),
      assignments: rows,
    },
  };
};

const parsePeriod = (req: Request): Period => {
  const period = (req.query.period ?? "weekly") as Period;
  if (!ALLOWED_PERIODS.includes(period)) {
    throw new BadRequestError("Period must be weekly, biweekly, or monthly");
  }
  return period;
};

// Both startDate and endDate are optional and treated as an inclusive
// calendar range (endDate's whole day counts) — callers that already know
// which exact days they want (the frontend's period-paging) send both;
// callers that just want "the current period" send neither and fall back
// to getPeriodRange inside buildTimesheetSummary.
const parseExplicitRange = (req: Request): { start: Date; end: Date } | undefined => {
  const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
  if (!startDate || !endDate) return undefined;
  return {
    start: dayjs(startDate).startOf("day").toDate(),
    end: dayjs(endDate).add(1, "day").startOf("day").toDate(),
  };
};

export const getMyTimesheet: MiddlewareFn = async (req, res) => {
  const period = parsePeriod(req);
  const range = parseExplicitRange(req);
  const { start, end, summary } = await buildTimesheetSummary(req.user.user_id.toString(), period, range);

  res.status(StatusCodes.OK).json({ success: true, period, start, end, summary });
};

// GET /timesheets/:id — admin/manager viewing a specific worker's timesheet
// summary on-screen, ahead of (or instead of) downloading the PDF.
export const getWorkerTimesheet: MiddlewareFn = async (req, res) => {
  if (!["admin", "manager"].includes(req.user.role)) {
    throw new UnauthorizedError("Not allowed to view this worker's timesheet.");
  }

  const { id } = req.params;
  const worker = await userModel
    .findOne({ _id: id, company: req.user.company_id })
    .select("_id")
    .lean();
  if (!worker) throw new NotFoundError("Worker not found.");

  const period = parsePeriod(req);
  const range = parseExplicitRange(req);
  const { start, end, summary } = await buildTimesheetSummary(id as string, period, range);

  res.status(StatusCodes.OK).json({ success: true, period, start, end, summary });
};
// Shared by the worker's own download and the admin/manager "view a
// worker's timesheet" download below — same PDF, same math, the only
// difference is whose id it's called with and who's allowed to call it.
const streamTimesheetPdf = async (
  workerId: string,
  startDate: string,
  endDate: string,
  res: Response
): Promise<void> => {
    const start = dayjs(startDate)
      .startOf("day")
      .toDate();

    /*
     * Use the next day as an exclusive upper bound.
     *
     * Example:
     * selected endDate = 28 Aug
     *
     * query:
     * >= 20 Aug 00:00
     * <  29 Aug 00:00
     */
    const endExclusive = dayjs(endDate)
      .add(1, "day")
      .startOf("day")
      .toDate();

    const worker = await userModel.findById(
      workerId
    ).lean();

    if (!worker) {
      throw new BadRequestError(
        "Worker not found."
      );
    }

    const company = await Company.findById(
      worker.company
    ).lean();

    if (!company) {
      throw new BadRequestError(
        "Company not found."
      );
    }

    const assignments =
      await JobAssignment.find({
        worker: workerId,

        status: "completed",

        isDeleted: false,

        checkedInAt: {
          $gte: start,
          $lt: endExclusive,
        },
      })
        .populate("job")
        .sort({
          checkedInAt: 1,
        })
        .lean();

    let regularMinutes = 0;
    let overtimeMinutes = 0;

    const rows: TimesheetPdfRow[] =
      assignments
        .filter(
          (assignment: any) =>
            assignment.job &&
            assignment.checkedInAt &&
            assignment.checkedOutAt
        )
        .map((assignment: any) => {
          const job = assignment.job;

          const grossMinutes =
            dayjs(
              assignment.checkedOutAt
            ).diff(
              dayjs(
                assignment.checkedInAt
              ),
              "minute"
            );

          const breakMinutes =
            (
              assignment.breaks ?? []
            ).reduce(
              (
                total: number,
                breakItem: any
              ) => {
                if (
                  !breakItem.startedAt ||
                  !breakItem.endedAt
                ) {
                  return total;
                }

                return (
                  total +
                  dayjs(
                    breakItem.endedAt
                  ).diff(
                    dayjs(
                      breakItem.startedAt
                    ),
                    "minute"
                  )
                );
              },
              0
            );

          const workedMinutes =
            Math.max(
              0,
              grossMinutes -
              breakMinutes
            );

          // approvedMinutes is what payroll actually pays for — capped
          // below workedMinutes until a manager approves an over-running
          // shift. Only approved overtime counts toward the overtime
          // summary; pending/rejected extra time is left off entirely.
          const approvedTotal =
            assignment.approvedMinutes ??
            workedMinutes;

          const approvedOvertimeMinutes =
            assignment.overtimeStatus === "approved"
              ? (assignment.overtimeMinutes ?? 0)
              : 0;

          const pendingOvertimeMinutes =
            assignment.overtimeStatus === "pending"
              ? (assignment.overtimeMinutes ?? 0)
              : 0;

          overtimeMinutes +=
            approvedOvertimeMinutes;

          regularMinutes += Math.max(
            0,
            approvedTotal -
            approvedOvertimeMinutes
          );

          return {
            date:
              job.date ??
              assignment.checkedInAt,

            jobTitle: job.title,

            location:
              job.address
                ? `${job.location}, ${job.address}`
                : job.location ?? "—",

            /*
             * PDF shows actual check-in/out.
             * If you want scheduled time instead,
             * use job.startTime/job.endTime.
             */
            startTime: dayjs(
              assignment.checkedInAt
            ).format("HH:mm"),

            endTime: dayjs(
              assignment.checkedOutAt
            ).format("HH:mm"),

            breakMinutes,

            workedMinutes: approvedTotal,

            pendingOvertimeMinutes,
          };
        });

    const pdf =
      generateTimesheetPdf({
        employeeName:
          worker.fullname,

        employeeEmail:
          worker.email,

        companyName:
          company.name,

        periodStart: start,

        periodEnd: dayjs(
          endExclusive
        )
          .subtract(1, "day")
          .toDate(),

        rows,

        regularMinutes,

        overtimeMinutes,
      });

    const filename =
      `timesheet-${dayjs(start).format(
        "YYYY-MM-DD"
      )}-${dayjs(endDate).format(
        "YYYY-MM-DD"
      )}.pdf`;

    res.setHeader(
      "Content-Type",
      "application/pdf"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`
    );

    pdf.pipe(res);

    pdf.end();
};

const parsePdfDateRange = (req: Request): { startDate: string; endDate: string } => {
  const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
  if (!startDate || !endDate) {
    throw new BadRequestError("startDate and endDate are required.");
  }
  return { startDate, endDate };
};

export const downloadMyTimesheetPdf: MiddlewareFn = async (req, res) => {
  const { startDate, endDate } = parsePdfDateRange(req);
  await streamTimesheetPdf(req.user.user_id.toString(), startDate, endDate, res);
};

// GET /timesheets/:id/pdf — admin/manager viewing a specific worker's
// timesheet, e.g. from the worker profile page's "Download Timesheet"
// action. Same PDF as downloadMyTimesheetPdf, just for someone else's shifts
// and gated to management rather than "whoever is logged in".
export const downloadWorkerTimesheetPdf: MiddlewareFn = async (req, res) => {
  if (!["admin", "manager"].includes(req.user.role)) {
    throw new UnauthorizedError("Not allowed to view this worker's timesheet.");
  }

  const { id } = req.params;
  const worker = await userModel
    .findOne({ _id: id, company: req.user.company_id })
    .select("_id")
    .lean();
  if (!worker) throw new NotFoundError("Worker not found.");

  const { startDate, endDate } = parsePdfDateRange(req);
  await streamTimesheetPdf(id as string, startDate, endDate, res);
};