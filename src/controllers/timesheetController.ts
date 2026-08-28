import { MiddlewareFn } from "../interfaces/expresstype.js";
import dayjs from "dayjs";
import JobAssignment from "../models/JobAssignment.js";
import { BadRequestError } from "../errors/customErrors.js";
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
export const getMyTimesheet: MiddlewareFn = async (req, res) => {
  console.log("enter here");

  const workerId = req.user.user_id;

  const period = (req.query.period ?? "weekly") as Period;

  const allowedPeriods: Period[] = [
    "weekly",
    "biweekly",
    "monthly",
  ];

  if (!allowedPeriods.includes(period)) {
    throw new BadRequestError(
      "Period must be weekly, biweekly, or monthly"
    );
  }

  const { start, end } = getPeriodRange(period);

  const assignments = await JobAssignment.find({
    worker: workerId,
    status: "completed",
    isDeleted: false,

    checkedInAt: {
      $gte: start,
      $lt: end,
    },
  })
    .populate("job")
    .sort({ checkedInAt: 1 });

  const totalMinutes = assignments.reduce(
    (total: number, assignment) => {
      // approvedMinutes is what actually counts for payroll — it's capped
      // below the raw worked time whenever a shift ran over and hasn't been
      // manager-approved yet. Older records predating this field fall back
      // to the raw computation.
      if (assignment.approvedMinutes != null) {
        return total + assignment.approvedMinutes;
      }

      if (
        !assignment.checkedInAt ||
        !assignment.checkedOutAt
      ) {
        return total;
      }

      const grossMinutes = dayjs(
        assignment.checkedOutAt
      ).diff(
        dayjs(assignment.checkedInAt),
        "minute"
      );

      // Convert Mongoose DocumentArray to normal JS array
      const breaks = Array.from(
        assignment.breaks ?? []
      );

      const breakMinutes = breaks.reduce(
        (sum: number, breakItem) => {
          if (
            !breakItem.startedAt ||
            !breakItem.endedAt
          ) {
            return sum;
          }

          const minutes = dayjs(
            breakItem.endedAt
          ).diff(
            dayjs(breakItem.startedAt),
            "minute"
          );

          return sum + minutes;
        },
        0
      );

      const workedMinutes = Math.max(
        0,
        grossMinutes - breakMinutes
      );

      return total + workedMinutes;
    },
    0
  );

  console.log("summary:", {
    totalJobs: assignments.length,
    totalMinutes,
    totalHours: Number(
      (totalMinutes / 60).toFixed(2)
    ),
  });

  res.status(StatusCodes.OK).json({
    success: true,
    period,
    start,
    end,

    summary: {
      totalJobs: assignments.length,
      totalMinutes,
      totalHours: Number(
        (totalMinutes / 60).toFixed(2)
      ),
    },

    assignments,
  });
};
export const downloadMyTimesheetPdf: MiddlewareFn =
  async (req, res) => {

    const workerId = req.user.user_id;

    const {
      startDate,
      endDate,
    } = req.query as {
      startDate?: string;
      endDate?: string;
    };

    if (!startDate || !endDate) {
      throw new BadRequestError(
        "startDate and endDate are required."
      );
    }

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