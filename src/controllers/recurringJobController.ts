import { StatusCodes } from "http-status-codes";
import mongoose from "mongoose";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { getReqUser, MiddlewareFn } from "../interfaces/expresstype.js";
import Job from "../models/jobModel.js";
import JobAssignment from "../models/JobAssignment.js";
import recurringJobModel from "../models/recurringJobModel.js";
import { toUtcDay } from "../utils/dates.js";
import { logActivity, logActivityMany } from "../utils/logActivity.js";
import { generateOccurrences } from "../utils/generateOccurrences.js";
import { jobDurationMinutes } from "./jobController.js";
import dayjs from "../utils/dayjsSetup.js";

/**
 * GET /recurring-jobs
 * The schedules list. Each row carries its template's details plus a count of
 * how many occurrences exist and where generation has reached, since that's
 * what a manager needs to see at a glance.
 */
export const getRecurringJobs: MiddlewareFn = async (req, res) => {
  const { active, page = "1", limit = "20" } = req.query;

  const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
  const limitNum = Math.max(1, parseInt(limit as string, 10) || 20);

  // Cast explicitly: the aggregate() $match below sends this straight to
  // MongoDB with no Mongoose auto-casting, so a raw string here (as
  // req.user.company_id is, straight off the JWT) would silently match
  // nothing against the ObjectId-typed `company` field.
  const match: Record<string, any> = {
    company: new mongoose.Types.ObjectId(getReqUser(req).company_id.toString()),
  };
  if (active === "true") match.active = true;
  if (active === "false") match.active = false;

  const [schedules, total] = await Promise.all([
    recurringJobModel.aggregate([
      { $match: match },
      { $sort: { createdAt: -1 } },
      { $skip: (pageNum - 1) * limitNum },
      { $limit: limitNum },
      {
        $lookup: {
          from: "jobs",
          localField: "templateJob",
          foreignField: "_id",
          as: "templateJob",
        },
      },
      { $unwind: { path: "$templateJob", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "jobs",
          let: { scheduleId: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$recurringJob", "$$scheduleId"] } } },
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                upcoming: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $gte: ["$date", toUtcDay(new Date())] },
                          { $not: [{ $in: ["$status", ["cancelled", "completed"]] }] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                nextDate: { $min: { $cond: [{ $gte: ["$date", toUtcDay(new Date())] }, "$date", null] } },
              },
            },
          ],
          as: "counts",
        },
      },
      {
        $addFields: {
          occurrenceCount: { $ifNull: [{ $first: "$counts.total" }, 0] },
          upcomingCount: { $ifNull: [{ $first: "$counts.upcoming" }, 0] },
          nextOccurrence: { $first: "$counts.nextDate" },
        },
      },
      { $project: { counts: 0 } },
    ]),
    recurringJobModel.countDocuments(match),
  ]);

  res.status(StatusCodes.OK).json({
    success: true,
    schedules,
    page: pageNum,
    limit: limitNum,
    total,
    totalPages: Math.ceil(total / limitNum),
  });
};

/**
 * GET /recurring-jobs/:id
 * One schedule with its upcoming occurrences, so the detail page can show
 * exactly what's scheduled before a manager decides to change or cancel it.
 */
export const getRecurringJob: MiddlewareFn = async (req, res) => {
  const { id } = req.params;

  const schedule = await recurringJobModel
    .findOne({ _id: id, company: getReqUser(req).company_id })
    .populate("templateJob")
    .populate("defaultWorkers", "fullname email")
    .populate("createdBy", "fullname")
    .lean();

  if (!schedule) throw new NotFoundError("Recurring schedule not found");

  const occurrences = await Job.find({
    recurringJob: id,
    isDeleted: false,
  })
    .sort({ date: 1 })
    .select("title date startTime endTime status requiredWorkers")
    .lean();

  const today = toUtcDay(new Date());
  const upcoming = occurrences.filter(o => o.date >= today);
  const past = occurrences.filter(o => o.date < today);

  res.status(StatusCodes.OK).json({
    success: true,
    schedule,
    occurrences: { upcoming, past, total: occurrences.length },
  });
};

/**
 * PATCH /recurring-jobs/:id
 * Edits the recurrence pattern. Only affects occurrences generated from now
 * on — already-created shifts are real, possibly-accepted work and are left
 * alone. Changing the pattern resets generatedUntil so the new rule takes
 * effect from today.
 */
export const updateRecurringJob: MiddlewareFn = async (req, res) => {
  const { id } = req.params;
  const { frequency, interval, daysOfWeek, endDate, maxOccurrences, defaultWorkers, startTime, endTime } = req.body;

  const schedule = await recurringJobModel.findOne({ _id: id, company: getReqUser(req).company_id });
  if (!schedule) throw new NotFoundError("Recurring schedule not found");

  // The shift's actual start/end time lives on the hidden template job, not
  // on the schedule document — generateOccurrences() copies startTime/
  // endTime/minutes from it verbatim for every future occurrence it creates.
  // Updating it here (before the regeneration below) is what makes "change
  // the duration for future shifts" actually take effect.
  if (startTime !== undefined || endTime !== undefined) {
    const templateJob = await Job.findById(schedule.templateJob);
    if (!templateJob) throw new NotFoundError("Template job not found for this schedule");

    const nextStartTime = startTime ?? templateJob.startTime;
    const nextEndTime = endTime ?? templateJob.endTime;

    templateJob.startTime = nextStartTime;
    templateJob.endTime = nextEndTime;
    templateJob.minutes = jobDurationMinutes(nextStartTime, nextEndTime);
    await templateJob.save();
  }

  if (frequency !== undefined) {
    if (!["daily", "weekly", "monthly"].includes(frequency)) {
      throw new BadRequestError("Invalid frequency");
    }
    schedule.frequency = frequency;
  }

  if (interval !== undefined) {
    const n = Number(interval);
    if (!Number.isInteger(n) || n < 1) {
      throw new BadRequestError("interval must be a positive whole number");
    }
    schedule.interval = n;
  }

  if (daysOfWeek !== undefined) {
    const days = (daysOfWeek as any[]).map(Number);
    if (!days.length || days.some(d => Number.isNaN(d) || d < 0 || d > 6)) {
      throw new BadRequestError("daysOfWeek values must be between 0 and 6");
    }
    schedule.daysOfWeek = days;
  }

  if (schedule.frequency === "weekly" && !schedule.daysOfWeek?.length) {
    throw new BadRequestError("daysOfWeek is required for weekly recurrence");
  }

  if (endDate !== undefined) {
    const normalized = endDate ? toUtcDay(endDate) : undefined;
    if (normalized && normalized < schedule.startDate) {
      throw new BadRequestError("endDate cannot be before the start date");
    }
    schedule.endDate = normalized;
  }

  if (maxOccurrences !== undefined) schedule.maxOccurrences = maxOccurrences;
  if (defaultWorkers !== undefined) schedule.defaultWorkers = defaultWorkers;

  // The pattern changed, so anything generated ahead of today is now built on
  // the old rule. Drop those and regenerate from the new one.
  const today = toUtcDay(new Date());
  const staleFuture = await Job.find({
    recurringJob: id,
    date: { $gt: today },
    status: { $nin: ["completed", "cancelled"] },
  }).distinct("_id");

  if (staleFuture.length) {
    await JobAssignment.deleteMany({
      job: { $in: staleFuture },
      status: "pending", // never remove work someone already accepted
    });
    await Job.deleteMany({
      $and: [
        { _id: { $in: staleFuture } },
        // Only jobs with no remaining assignments — if a worker accepted, the
        // shift stays and the manager deals with it explicitly
        { _id: { $nin: await JobAssignment.find({ job: { $in: staleFuture } }).distinct("job") } },
      ],
    });
  }

  schedule.generatedUntil = undefined;
  await schedule.save();

  const generatedUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const regenerated = await generateOccurrences(schedule, generatedUntil);

  await logActivity({
    job: schedule.templateJob,
    type: "job_updated",
    actor: getReqUser(req).user_id,
    metadata: { recurringSchedule: true, regenerated: regenerated.length },
  });

  res.status(StatusCodes.OK).json({
    success: true,
    schedule,
    regenerated: regenerated.length,
  });
};

/**
 * PATCH /recurring-jobs/:id/cancel
 * Stops the schedule generating new occurrences. Whether to also cancel the
 * shifts already scheduled is a separate decision — "we're not renewing next
 * month" and "nobody's working any of it" are different intents.
 *
 * Never touches completed or in-progress shifts: finished work stays on the
 * timesheet, and someone currently on site doesn't lose their shift.
 */
export const cancelRecurringJob: MiddlewareFn = async (req, res) => {
  const { id } = req.params;
  const { cancelFutureJobs = false } = req.body;

  const schedule = await recurringJobModel.findOne({ _id: id, company: getReqUser(req).company_id });
  if (!schedule) throw new NotFoundError("Recurring schedule not found");

  schedule.active = false;
  await schedule.save();

  let cancelledJobs = 0;
  let notifiedWorkers: string[] = [];

  if (cancelFutureJobs) {
    const today = toUtcDay(new Date());

    const futureJobs = await Job.find({
      recurringJob: id,
      date: { $gte: today },
      status: { $nin: ["completed", "cancelled"] },
      isDeleted: false,
    })
      .select("_id date")
      .lean();

    const futureJobIds = futureJobs.map(j => j._id);

    if (futureJobIds.length) {
      // Workers who'd accepted need telling — collect them before the update
      const affected = await JobAssignment.find({
        job: { $in: futureJobIds },
        status: "accepted",
      })
        .populate("worker", "fullname email")
        .lean();

      notifiedWorkers = [
        ...new Set(affected.map((a: any) => a.worker?.email).filter(Boolean)),
      ];

      const result = await Job.updateMany(
        { _id: { $in: futureJobIds } },
        { status: "cancelled" }
      );
      cancelledJobs = result.modifiedCount;

      await JobAssignment.updateMany(
        { job: { $in: futureJobIds }, status: { $in: ["pending", "accepted"] } },
        {
          status: "cancelled",
          cancellationReason: "Recurring shift cancelled by manager",
        }
      );

      await logActivityMany(
        futureJobs.map(j => ({
          job: j._id,
          jobDate: j.date,
          type: "job_cancelled" as const,
          actor: getReqUser(req).user_id,
          metadata: { reason: "Recurring schedule cancelled" },
        }))
      );
    }
  }

  res.status(StatusCodes.OK).json({
    success: true,
    message: cancelFutureJobs
      ? `Schedule stopped and ${cancelledJobs} upcoming shift${cancelledJobs === 1 ? "" : "s"} cancelled.`
      : "Schedule stopped. Shifts already scheduled are unchanged.",
    cancelledJobs,
    notifiedWorkers,
  });
};

/**
 * PATCH /recurring-jobs/:id/reactivate
 * Turns a stopped schedule back on. generatedUntil is reset to today first —
 * otherwise a schedule paused for a month would try to backfill dates in the
 * past, creating shifts nobody worked.
 */
export const reactivateRecurringJob: MiddlewareFn = async (req, res) => {
  const { id } = req.params;

  const schedule = await recurringJobModel.findOne({ _id: id, company: getReqUser(req).company_id });
  if (!schedule) throw new NotFoundError("Recurring schedule not found");

  if (schedule.active) {
    throw new BadRequestError("This schedule is already running.");
  }

  if (schedule.endDate && schedule.endDate < new Date()) {
    throw new BadRequestError(
      "This schedule's end date has passed. Set a new end date before reactivating."
    );
  }

  schedule.active = true;
  // Resume from today, not from wherever it left off
  schedule.generatedUntil = toUtcDay(new Date());
  await schedule.save();

  const generatedUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const generated = await generateOccurrences(schedule, generatedUntil);

  res.status(StatusCodes.OK).json({
    success: true,
    message: `Schedule restarted — ${generated.length} shift${generated.length === 1 ? "" : "s"} created.`,
    generated: generated.length,
  });
};