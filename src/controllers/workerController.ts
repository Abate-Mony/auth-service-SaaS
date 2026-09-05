import { StatusCodes } from "http-status-codes";
import mongoose from "mongoose";
import { BadRequestError, NotFoundError, UnauthenticatedError } from "../errors/customErrors.js";
import { getReqUser, MiddlewareFn } from "../interfaces/expresstype.js";
import JobAssignment from "../models/JobAssignment.js";
import jobModel from "../models/jobModel.js";
import userModel from "../models/userModel.js";
import { hashPassword } from "../utils/passwordUtils.js";
import { logActivity, logActivityMany } from "../utils/logActivity.js";
import recurringJobModel from "../models/recurringJobModel.js";
import dayjs from "../utils/dayjsSetup.js";
import Company from "../models/company.js";
import { scheduledEndOf, scheduledStartOf, toUtcDay, TZ } from "../utils/dates.js";
import { checkGeofence } from "../utils/geo.js";
import { sendWorkerJobStatusEmail } from "../utils/sendMailsUtils.js";
import { sendRecurringSeriesResponse, sendOpenShiftClaimNotice, sendClaimReviewResultEmail } from "../utils/mailTemplates.js";
import { sendPushToUser } from "../utils/webPush.js";
import { shouldNotify } from "../services/notificationPreferenceService.js";
import { sanitizeUser } from "../utils/tokenUtils.js";
import { buildRestrictionResponse } from "../middleware/restrictionMiddleware.js";
import { RestrictableAction } from "../models/userRestrictionModel.js";

// Which restriction the worker-status route enforces depends on the status
// being requested, not the route itself — "declined" has no restrictable
// action, a worker can always turn down a shift.
const RESTRICTION_ACTION_FOR_STATUS: Partial<Record<string, RestrictableAction>> = {
    accepted: "accept_jobs",
    "in-progress": "clock_in",
    completed: "clock_out",
};

export const createWorker: MiddlewareFn = async (req, res) => {
    const { fullname, email, password, role } = req.body;
    const currentUser = req.user;
    const User = await userModel.findOne({ _id: req.user.user_id })
    if (!User) throw new BadRequestError("could not find user but this is impossible ")

    if (["admin"].includes(role)) {
        throw new BadRequestError("Invalid role. Only 'worker or manager' role can be created.");
    }


    const existingUser = await userModel.findOne({ email: email.toLowerCase() });
    if (existingUser) {
        throw new BadRequestError("Email already exists")
    }

    const hashedPassword = await hashPassword(password);

    const worker = await userModel.create({
        fullname,
        email: email.toLowerCase(),
        password: hashedPassword,
        role: role,
        createdBy: currentUser.user_id,
        company: User?.company
    });

    res.status(StatusCodes.CREATED).json({
        message: "Worker created successfully.",
        worker: sanitizeUser(worker),
    });
};

export const getMyJobs: MiddlewareFn = async (req, res) => {
    const startTime = new Date()
    const workerId = new mongoose.Types.ObjectId(req.user.user_id);
    const { search, status, page = "1", limit = "10", start, end } = req.query;

    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit as string, 10) || 20);

    const assignmentMatch: Record<string, any> = { worker: workerId, isDeleted: false };
    if (status && status !== "all") {
        assignmentMatch.status = status;
    }

    // job.date is always normalised to UTC midnight (toUtcDay), so plain
    // $gte/$lte bounds are exact — no need for an exclusive end-of-day.
    let jobDateMatch: Record<string, Date> | undefined;
    if (start || end) {
        jobDateMatch = {};
        try {
            if (start) jobDateMatch.$gte = toUtcDay(start as string);
            if (end) jobDateMatch.$lte = toUtcDay(end as string);
        } catch {
            throw new BadRequestError("Invalid start or end date");
        }
    }

 const lookupJob: mongoose.PipelineStage.Lookup = {
    $lookup: {
        from: "jobs",
        let: { jobId: "$job" },
        pipeline: [
            {
                $match: {
                    $expr: {
                        $eq: ["$_id", "$$jobId"]
                    },

                    isDeleted: false,

                    // Draft jobs are internal to managers/admins.
                    // Workers should not see them until published.
                    status: {
                        $ne: "draft"
                    }
                }
            },
        ],
        as: "job",
    },
};
    const unwindJob: mongoose.PipelineStage.Unwind = { $unwind: "$job" };
    const projectRow: mongoose.PipelineStage.Project = {
        $project: {
            job: 1,
            status: 1, // assignment status overrides job's own status, same as before
            workerJobDetails: {
                assignmentId: "$_id",
                acceptedAt: "$acceptedAt",
                declinedAt: "$declinedAt",
                checkedInAt: "$checkedInAt",
                checkedOutAt: "$checkedOutAt",
                completedAt: "$completedAt",
                hoursWorked: "$hoursWorked",
            },
        },
    };

    // The job join has to happen BEFORE the facet (not just inside the data
    // branch) because it also drops assignments whose job was soft-deleted.
    // If skip/limit ran first, a deleted job in the current page would leave
    // that page short instead of backfilling from the next one, and
    // totalCount would count assignments that can never appear in any page.
    // Sorting by job.date also has to happen after the join, since that
    // field lives on the job doc, not the assignment.
    const pipeline: mongoose.PipelineStage[] = [
        { $match: assignmentMatch },
        lookupJob,
        unwindJob,
        ...(search ? [{ $match: { "job.title": { $regex: search as string, $options: "i" } } }] : []),
        ...(jobDateMatch ? [{ $match: { "job.date": jobDateMatch } }] : []),
        { $sort: { "job.date": 1 as const } },
        {
            $facet: {
                data: [
                    { $skip: (pageNum - 1) * limitNum },
                    { $limit: limitNum },
                    projectRow,
                ],
                totalCount: [{ $count: "count" }],
            },
        },
    ];

    const [result] = await JobAssignment.aggregate(pipeline);
    const total = result.totalCount[0]?.count ?? 0;

    const jobs = result.data.map((row: any) => ({
        ...row.job,
        status: row.status, // assignment status wins over job.status, same behavior as your original .map
        workerJobDetails: row.workerJobDetails,
    }));
    const time_querying = dayjs().diff(startTime, "seconds", true)
    console.log("time quering is : ", time_querying)
    res.status(StatusCodes.OK).json({
        jobs,
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
    });
};

// Self-service total for the logged-in worker: sums hoursWorked across their
// completed assignments, optionally scoped to a date range via completedAt.
export const getMyTotalHours: MiddlewareFn = async (req, res) => {
    const workerId = new mongoose.Types.ObjectId(req.user.user_id);
    const { start, end } = req.query;

    const match: Record<string, any> = { worker: workerId, status: "completed" };

    if (start || end) {
        const completedAt: Record<string, Date> = {};
        if (start) {
            const startDate = new Date(start as string);
            if (isNaN(startDate.getTime())) throw new BadRequestError("Invalid start date");
            completedAt.$gte = startDate;
        }
        if (end) {
            const endDate = new Date(end as string);
            if (isNaN(endDate.getTime())) throw new BadRequestError("Invalid end date");
            completedAt.$lte = endDate;
        }
        match.completedAt = completedAt;
    }

    const [result] = await JobAssignment.aggregate([
        { $match: match },
        {
            $group: {
                _id: null,
                totalHours: { $sum: "$hoursWorked" },
                totalJobs: { $sum: 1 },
            },
        },
    ]);

    res.status(StatusCodes.OK).json({
        success: true,
        totalHours: result?.totalHours ?? 0,
        totalJobs: result?.totalJobs ?? 0,
    });
};

const ASSIGNMENT_STATUSES = ["pending", "accepted", "declined", "in-progress", "completed", "cancelled"] as const;

// Self-service dashboard summary for the logged-in worker. One aggregation,
// three facets: job counts by status (all-time), hours/pay stats from
// completed work (all-time), and earnings for the current calendar month.
// Add more facets here as new stats are needed.
export const getWorkerDashboardStats: MiddlewareFn = async (req, res) => {
  const workerId = new mongoose.Types.ObjectId(req.user.user_id);

  const monthStart = dayjs().startOf("month").toDate();
  const monthEnd = dayjs().endOf("month").toDate();

  const [result] = await JobAssignment.aggregate([
    {
      $match: {
        worker: workerId,
        isDeleted: false,
      },
    },

    {
      $facet: {
        statusCounts: [
          {
            $group: {
              _id: "$status",
              count: { $sum: 1 },
            },
          },
        ],

        monthlyStats: [
          {
            $match: {
              status: "completed",
              completedAt: {
                $gte: monthStart,
                $lte: monthEnd,
              },
            },
          },

          {
            $addFields: {
              payableMinutes: {
                $ifNull: [
                  "$approvedMinutes",
                  {
                    $ifNull: [
                      "$actualMinutes",
                      0,
                    ],
                  },
                ],
              },
            },
          },

          {
            $group: {
              _id: null,

              completedJobs: {
                $sum: 1,
              },

              totalMinutes: {
                $sum: "$payableMinutes",
              },

              averagePayRate: {
                $avg: "$payRate",
              },

              totalEarnings: {
                $sum: {
                  $multiply: [
                    {
                      $divide: [
                        "$payableMinutes",
                        60,
                      ],
                    },
                    "$payRate",
                  ],
                },
              },
            },
          },
        ],
      },
    },
  ]);

  const jobStats = Object.fromEntries(
    ASSIGNMENT_STATUSES.map((status) => [
      status,
      0,
    ])
  ) as Record<
    typeof ASSIGNMENT_STATUSES[number],
    number
  >;

  for (const row of result.statusCounts) {
    jobStats[
      row._id as typeof ASSIGNMENT_STATUSES[number]
    ] = row.count;
  }

  const monthly = result.monthlyStats[0] ?? {};

  const totalJobs = Object.values(jobStats).reduce(
    (total, count) => total + count,
    0
  );

  res.status(StatusCodes.OK).json({
    success: true,

    jobStats,

    monthly: {
      earnings: Number(
        (monthly.totalEarnings ?? 0).toFixed(2)
      ),

      totalMinutes:
        monthly.totalMinutes ?? 0,

      hoursWorked: Number(
        ((monthly.totalMinutes ?? 0) / 60).toFixed(2)
      ),

      completedJobs:
        monthly.completedJobs ?? 0,

      averagePayRate: Number(
        (monthly.averagePayRate ?? 0).toFixed(2)
      ),
    },

    totalJobs,
  });
};

export const getJob: MiddlewareFn = async (req, res) => {
    const { id } = req.params;

    const [job, jobAssignment] = await Promise.all([
        jobModel.findOne({ _id: id, isDeleted: false }),
        JobAssignment.findOne({ job: id, worker: req.user.user_id, isDeleted: false }),
    ]);
    if (!job) {
        throw new BadRequestError("Job not found.");
    }
    if (!jobAssignment) {
        throw new NotFoundError("You are not assigned to this job.");
    }

    const job_ = {
        ...job.toObject(),
        status: jobAssignment.status,
        workerJobDetails: jobAssignment,
    };

    res.status(StatusCodes.OK).json({
        job: job_,
        success: true,
    });
};
export const getActiveJob: MiddlewareFn = async (req, res) => {
    const assignment = await JobAssignment.findOne({
        status: "in-progress",
        worker: req.user.user_id,
        isDeleted: false
    })
        .populate({ path: "job", match: { isDeleted: false } })
        .lean();

    if (!assignment || !assignment.job) {
        res.status(StatusCodes.OK).json({ success: true, job: null });
        return;
    }

    res.status(StatusCodes.OK).json({
        success: true,
        job: {
            ...(assignment.job as any),
            status: assignment.status,
            workerJobDetails: assignment,
        },
    });
};

// Single source of truth for worker-driven status transitions.
// checkInJob below now just calls this instead of duplicating the logic.
export const updateWorkerJobStatus: MiddlewareFn = async (req, res) => {
    const worker = await userModel.findOne({
        _id: req.user.user_id
    })
    if (!worker) throw new UnauthenticatedError("user not login ")

    const { id } = req.params;
    const { status, reason } = req.body;

    const allowedStatuses = ["accepted", "declined", "in-progress", "completed"];
    if (!allowedStatuses.includes(status)) {
        throw new BadRequestError("Invalid status");
    }

    const workerId = req.user.user_id;

    const assignment = await JobAssignment.findOne({
        worker: workerId,
        job: id, isDeleted: false
    });
    if (!assignment) {
        throw new NotFoundError("You are not assigned to this job.");
    }

    // The blocked action depends on the requested status, so this is checked
    // here rather than as route-level middleware. A worker already mid-shift
    // must always be able to clock out — losing their recorded hours and pay
    // to a restriction created after they started is never the right outcome.
    const restrictedAction = RESTRICTION_ACTION_FOR_STATUS[status as keyof typeof RESTRICTION_ACTION_FOR_STATUS];
    if (restrictedAction && req.restriction?.blocks(restrictedAction)) {
        const clockingOutMidShift = restrictedAction === "clock_out" && assignment.status === "in-progress";
        if (!clockingOutMidShift) {
            res.status(StatusCodes.FORBIDDEN).json(buildRestrictionResponse(req.restriction));
            return;
        }
    }

    const job = await jobModel.findOne({ _id: assignment.job, isDeleted: false }).lean();
    if (!job) throw new NotFoundError("Job not found.");

    // Loaded once and reused by whichever branch below needs it (only
    // "in-progress" and "completed" do) rather than querying per case.
    const company = await Company.findById(job.company)
        .select("clockInGraceMinutes geofenceMode defaultGeofenceRadiusMeters timezone lateClockOutThresholdMinutes")
        .lean();
    const tz = company?.timezone ?? TZ;

    const now = new Date();
    const scheduledStart = scheduledStartOf(job, tz);
    const scheduledEnd = scheduledEndOf(job, tz);
    const emailJobRequirement = {
        _id: job._id.toString(),
        date: job.date,
        endTime: job.endTime,
        startTime: job.startTime,
        title: job.title
    }

    // Fire-and-forget: the worker's accept/decline response shouldn't wait
    // on notifying the manager, and a failed send shouldn't fail the
    // status change. Each channel is gated by the manager's own
    // notification preferences (falls back to system defaults if they
    // haven't set any — see notificationPreferenceService.shouldNotify).
    async function notifyManagerOfStatusChange(
        event: "job_accepted" | "job_declined",
        emailType: "accept-job" | "reject-job",
        reason?: string
    ) {
        const manager = await userModel.findOne({ _id: job!.createdBy! }).select("email");
        if (!manager) return;

        const managerId = manager._id.toString();
        const [canEmail, canPush] = await Promise.all([
            shouldNotify(managerId, event, "email"),
            shouldNotify(managerId, event, "push"),
        ]);

        await Promise.all([
            canEmail
                ? sendWorkerJobStatusEmail({
                    type: emailType,
                    adminEmail: manager.email,
                    worker: { fullname: worker!.fullname },
                    job: emailJobRequirement,
                    reason,
                })
                : Promise.resolve(),
            canPush
                ? sendPushToUser(managerId, {
                    title: event === "job_accepted" ? "Shift accepted" : "Shift declined",
                    body: event === "job_accepted"
                        ? `${worker!.fullname} accepted ${job!.title} — ${job!.startTime} on ${dayjs(job!.date).tz(tz).format("D MMM")}`
                        : `${worker!.fullname} declined ${job!.title}${reason ? `: ${reason}` : ""}`,
                    tag: `assignment-status-${assignment!._id}`,
                    url: `/jobs/${job!._id}`,
                })
                : Promise.resolve(),
        ]);
    }

    // Fire-and-forget: flags an over-running shift for the manager to
    // approve/adjust/reject rather than silently paying (or silently
    // dropping) the extra time. Gated the same way as the accept/decline
    // notifications above.
    async function notifyManagerOfOvertime(overtimeMinutes: number) {
        const manager = await userModel.findOne({ _id: job!.createdBy! }).select("email");
        if (!manager) return;

        const managerId = manager._id.toString();
        const [canEmail, canPush] = await Promise.all([
            shouldNotify(managerId, "worker_checked_out", "email"),
            shouldNotify(managerId, "worker_checked_out", "push"),
        ]);

        await Promise.all([
            canEmail
                ? sendWorkerJobStatusEmail({
                    type: "overtime-review",
                    adminEmail: manager.email,
                    worker: { fullname: worker!.fullname },
                    job: emailJobRequirement,
                    overtimeMinutes,
                })
                : Promise.resolve(),
            canPush
                ? sendPushToUser(managerId, {
                    title: "Overtime needs review",
                    body: `${worker!.fullname} clocked out ${overtimeMinutes}m late on ${job!.title} — extra time needs approval`,
                    tag: `assignment-overtime-${assignment!._id}`,
                    url: `/jobs/${job!._id}`,
                })
                : Promise.resolve(),
        ]);
    }

    switch (status) {
        case "accepted": {
            if (assignment.status !== "pending") {
                throw new BadRequestError(`You cannot accept a job that is ${assignment.status}.`);
            }

            assignment.status = "accepted";
            assignment.acceptedAt = now;

            notifyManagerOfStatusChange("job_accepted", "accept-job").catch(err =>
                console.error(`Failed to notify manager of accepted assignment ${assignment._id}:`, err)
            );

            await logActivity({
                job: assignment.job,
                jobDate: job.date,
                assignment: assignment._id,
                worker: assignment.worker,
                type: "assignment_accepted",
                actor: workerId,
                metadata: {
                    // How long they took to respond after being assigned
                    responseMinutes: Math.round(
                        (now.getTime() - new Date(assignment.createdAt).getTime()) / 60_000
                    ),
                },
            });
            break;
        }

        case "declined": {
            if (assignment.status !== "pending") {
                throw new BadRequestError(`You cannot decline a job that is ${assignment.status}.`);
            }

            assignment.status = "declined";
            assignment.declinedAt = now;
            assignment.cancellationReason = (reason ?? "").trim();

            notifyManagerOfStatusChange("job_declined", "reject-job", assignment.cancellationReason).catch(err =>
                console.error(`Failed to notify manager of declined assignment ${assignment._id}:`, err)
            );

            await logActivity({
                job: assignment.job,
                jobDate: job.date,
                assignment: assignment._id,
                worker: assignment.worker,
                type: "assignment_declined",
                actor: workerId,
                metadata: {
                    reason: assignment.cancellationReason || null,
                    responseMinutes: Math.round(
                        (now.getTime() - new Date(assignment.createdAt).getTime()) / 60_000
                    ),
                    // How much notice the manager has to backfill
                    hoursNotice: Math.round((scheduledStart.getTime() - now.getTime()) / 3_600_000),
                },
            });
            break;
        }

        case "in-progress": {
            if (assignment.status !== "accepted") {
                throw new BadRequestError("You must accept the job before starting it.");
            }
            if (assignment.checkedInAt) {
                throw new BadRequestError("You have already checked in.");
            }

            const hasActiveJob = await JobAssignment.exists({
                worker: workerId,
                status: "in-progress",
            });
            if (hasActiveJob) {
                throw new BadRequestError(
                    "You already have an active job — complete it before starting another."
                );
            }

            // ── time window ────────────────────────────────────────────────
            const graceMinutes = company?.clockInGraceMinutes ?? 30;
            const earliest = new Date(scheduledStart.getTime() - graceMinutes * 60_000);
            if (now < earliest) {
                throw new BadRequestError(
                    `This shift starts at ${job.startTime} on ${dayjs(job.date).tz(tz).format("D MMM")}. You can clock in from ${dayjs(earliest).tz(tz).format("HH:mm")}.`
                );
            }
            if (now > scheduledEnd) {
                throw new BadRequestError("This shift has already ended. Contact your manager.");
            }

            // ── geofence ─────────────────────────────────────────────────
            const location = req.body?.location ?? {};
            const rawLat = location?.lat;
            const rawLng = location?.lng;
            const rawAccuracy = location?.accuracy;

            const lat = typeof rawLat === "number" && Number.isFinite(rawLat) ? rawLat : undefined;
            const lng = typeof rawLng === "number" && Number.isFinite(rawLng) ? rawLng : undefined;
            const accuracy = typeof rawAccuracy === "number" && Number.isFinite(rawAccuracy) ? rawAccuracy : undefined;

            const workerCoords: { lat: number; lng: number; accuracy?: number } | null =
                lat != null && lng != null
                    ? {
                        lat,
                        lng,
                        ...(accuracy !== undefined ? { accuracy } : {}),
                    }
                    : null;

            const jobCoords: { lat: number; lng: number } | null =
                job.coordinates &&
                    typeof job.coordinates.lat === "number" &&
                    Number.isFinite(job.coordinates.lat) &&
                    typeof job.coordinates.lng === "number" &&
                    Number.isFinite(job.coordinates.lng)
                    ? {
                        lat: job.coordinates.lat,
                        lng: job.coordinates.lng,
                    }
                    : null;

            // const mode = company?.geofenceMode ?? "warn";
            const mode = job.geofenceMode ?? company?.geofenceMode ?? "warn";
            const geo = checkGeofence({
                jobCoords,
                workerCoords,
                radiusMeters: job.geofenceRadiusMeters ?? company?.defaultGeofenceRadiusMeters ?? 150,
            });

            if (mode === "enforce" && geo.flagged && !geo.inconclusive) {
                throw new BadRequestError(
                    `You appear to be ${geo.distanceMeters}m from ${job.location}. Move closer to the site, or ask your manager to clock you in.`
                );
            }

            if (workerCoords) {
                assignment.checkInLocation = workerCoords;
                assignment.checkInDistanceMeters = geo.distanceMeters ?? undefined;
                assignment.checkInFlagged = mode !== "off" && geo.flagged;
            }

            assignment.checkedInAt = now;
            assignment.status = "in-progress";

            const minutesLate = Math.round((now.getTime() - scheduledStart.getTime()) / 60_000);

            await logActivity({
                job: assignment.job,
                jobDate: job.date,
                assignment: assignment._id,
                worker: assignment.worker,
                type: "assignment_checked_in",
                actor: workerId,
                metadata: {
                    minutesLate,
                    location: job.location,
                    distanceMeters: geo.distanceMeters,
                    flagged: assignment.checkInFlagged,
                    accuracy: workerCoords?.accuracy ?? null,
                },
            });
            break;
        }
        case "completed": {
            if (assignment.status !== "in-progress") {
                throw new BadRequestError("You must start the job before completing it.");
            }
            if (!assignment.checkedInAt) {
                throw new BadRequestError("No check-in recorded for this shift.");
            }

            const openBreak = assignment.breaks?.find(b => !b.endedAt);
            if (openBreak) openBreak.endedAt = now;

            // ── location ─────────────────────────────────────────────────
            const location = req.body?.location ?? {};
            const rawLat = location?.lat;
            const rawLng = location?.lng;
            const rawAccuracy = location?.accuracy;

            const lat = typeof rawLat === "number" && Number.isFinite(rawLat) ? rawLat : undefined;
            const lng = typeof rawLng === "number" && Number.isFinite(rawLng) ? rawLng : undefined;
            const accuracy =
                typeof rawAccuracy === "number" && Number.isFinite(rawAccuracy) ? rawAccuracy : undefined;

            const workerCoords: { lat: number; lng: number; accuracy?: number } | null =
                lat != null && lng != null
                    ? {
                        lat,
                        lng,
                        ...(accuracy !== undefined ? { accuracy } : {}),
                    }
                    : null;

            if (workerCoords) {
                assignment.checkOutLocation = workerCoords;
            }

            const jobCoords =
                job.coordinates &&
                    typeof job.coordinates.lat === "number" &&
                    Number.isFinite(job.coordinates.lat) &&
                    typeof job.coordinates.lng === "number" &&
                    Number.isFinite(job.coordinates.lng)
                    ? {
                        lat: job.coordinates.lat,
                        lng: job.coordinates.lng,
                    }
                    : null;

            const geo = checkGeofence({
                jobCoords,
                workerCoords,
                radiusMeters: job.geofenceRadiusMeters ?? company?.defaultGeofenceRadiusMeters ?? 150,
            });

            assignment.checkedOutAt = now;
            assignment.completedAt = now;
            assignment.status = "completed";

            const grossMinutes = Math.round(
                (now.getTime() - new Date(assignment.checkedInAt).getTime()) / 60_000
            );
            const breakMinutes = [...(assignment.breaks ?? [])].reduce(
                (sum, b) =>
                    b.endedAt
                        ? sum + Math.round(
                            (new Date(b.endedAt).getTime() - new Date(b.startedAt!).getTime()) / 60_000
                        )
                        : sum,
                0
            );
            const workedMinutes = Math.max(0, grossMinutes - breakMinutes);

            // ── overtime review ─────────────────────────────────────────
            // actualMinutes is the record of what really happened.
            // approvedMinutes is what payroll pays — capped at the scheduled
            // amount whenever the overrun is big enough to need a manager's
            // sign-off, so a forgotten clock-out (or a genuinely long shift)
            // never bills the company automatically.
            const rawReason = req.body?.clockOutReason;
            const allowedReasons = ["on_time", "job_took_longer", "manager_asked_to_stay", "other"];
            const clockOutReason = allowedReasons.includes(rawReason) ? rawReason : undefined;
            const clockOutNote = typeof req.body?.clockOutNote === "string" ? req.body.clockOutNote.trim() : "";

            const overtimeThreshold = company?.lateClockOutThresholdMinutes ?? 15;
            const overtimeMinutes = Math.max(0, workedMinutes - job.minutes);
            const requiresReview = overtimeMinutes > overtimeThreshold;

            assignment.actualMinutes = workedMinutes;
            assignment.overtimeMinutes = overtimeMinutes;
            assignment.approvedMinutes = requiresReview
                ? Math.max(0, workedMinutes - overtimeMinutes)
                : workedMinutes;
            assignment.overtimeStatus = requiresReview ? "pending" : "none";
            if (clockOutReason) assignment.clockOutReason = clockOutReason as any;
            if (clockOutNote) assignment.clockOutNote = clockOutNote;

            if (requiresReview) {
                notifyManagerOfOvertime(overtimeMinutes).catch(err =>
                    console.error(`Failed to notify manager of overtime for assignment ${assignment._id}:`, err)
                );
            }

            await logActivity({
                job: assignment.job,
                jobDate: job.date,
                assignment: assignment._id,
                worker: assignment.worker,
                type: "assignment_checked_out",
                actor: workerId,
                metadata: {
                    workedMinutes,
                    breakMinutes,
                    breakCount: (assignment.breaks ?? []).length,
                    scheduledMinutes: job.minutes,
                    // Positive = left early, negative = stayed late
                    minutesEarly: Math.round((scheduledEnd.getTime() - now.getTime()) / 60_000),
                    distanceMeters: geo.distanceMeters,
                    flagged: geo.flagged,
                    accuracy: workerCoords?.accuracy ?? null,
                    overtimeMinutes,
                    overtimeStatus: assignment.overtimeStatus,
                },
            });

            if (requiresReview) {
                await logActivity({
                    job: assignment.job,
                    jobDate: job.date,
                    assignment: assignment._id,
                    worker: assignment.worker,
                    type: "assignment_overtime_flagged",
                    actor: workerId,
                    metadata: { overtimeMinutes, clockOutReason, clockOutNote },
                });
            }
            break;
        }
    }

    await assignment.save();

    res.status(StatusCodes.OK).json({
        success: true,
        message: `Job ${status} successfully.`,
        assignment,
    });
};

// Manager-facing: approve, reject, or manually adjust a shift's flagged
// overtime. Only assignments this manager's own company owns can be
// reviewed, and only ones actually awaiting review.
export const reviewAssignmentOvertime: MiddlewareFn = async (req, res) => {
    const { assignmentId } = req.params;
    const { decision, approvedMinutes: overrideMinutes, managerNotes } = req.body;

    const allowedDecisions = ["approve", "reject", "adjust"];
    if (!allowedDecisions.includes(decision)) {
        throw new BadRequestError("decision must be 'approve', 'reject', or 'adjust'.");
    }

    const assignment = await JobAssignment.findOne({
        _id: assignmentId,
        company: req.user.company_id,
        isDeleted: false,
    });
    if (!assignment) throw new NotFoundError("Assignment not found.");

    if (assignment.overtimeStatus !== "pending") {
        throw new BadRequestError(
            `This assignment has no overtime awaiting review (status: ${assignment.overtimeStatus}).`
        );
    }

    if (decision === "adjust") {
        if (typeof overrideMinutes !== "number" || !Number.isFinite(overrideMinutes) || overrideMinutes < 0) {
            throw new BadRequestError("approvedMinutes must be a non-negative number for 'adjust'.");
        }
        assignment.approvedMinutes = Math.round(overrideMinutes);
        assignment.overtimeStatus = "approved";
    } else if (decision === "approve") {
        assignment.approvedMinutes = assignment.actualMinutes ?? assignment.approvedMinutes;
        assignment.overtimeStatus = "approved";
    } else {
        assignment.approvedMinutes = Math.max(0, (assignment.actualMinutes ?? 0) - (assignment.overtimeMinutes ?? 0));
        assignment.overtimeStatus = "rejected";
    }

    if (typeof managerNotes === "string") {
        assignment.managerNotes = managerNotes.trim();
    }

    assignment.overtimeReviewedBy = new mongoose.Types.ObjectId(req.user.user_id);
    assignment.overtimeReviewedAt = new Date();

    await assignment.save();

    await logActivity({
        job: assignment.job,
        assignment: assignment._id,
        worker: assignment.worker,
        type: "assignment_overtime_reviewed",
        actor: req.user.user_id,
        metadata: {
            decision,
            approvedMinutes: assignment.approvedMinutes,
            overtimeMinutes: assignment.overtimeMinutes,
        },
    });

    res.status(StatusCodes.OK).json({
        success: true,
        message: `Overtime ${decision}d.`,
        assignment,
    });
};

export const startWorkerBreak: MiddlewareFn = async (req, res) => {
    const { id } = req.params;

    const assignment = await JobAssignment.findOne({
        worker: req.user.user_id,
        job: id,
    });

    if (!assignment) {
        throw new NotFoundError("You are not assigned to this job.");
    }
    if (assignment.status !== "in-progress") {
        throw new BadRequestError("You can only take a break while the job is in progress.");
    }
    const openBreak = assignment.breaks?.find(b => !b.endedAt);
    if (openBreak) {
        throw new BadRequestError("You are already on a break.");
    }

    assignment.breaks?.push({ startedAt: new Date() });
    await assignment.save();

    await logActivity({
        job: assignment.job,
        assignment: assignment._id,
        worker: assignment.worker,
        type: "assignment_break_started",
        actor: req.user.user_id,
    });

    res.status(StatusCodes.OK).json({
        success: true,
        message: "Break started.",
        assignment,
    });
};

export const endWorkerBreak: MiddlewareFn = async (req, res) => {
    const { id } = req.params;

    const assignment = await JobAssignment.findOne({
        worker: req.user.user_id,
        job: id,
    });

    if (!assignment) {
        throw new NotFoundError("You are not assigned to this job.");
    }

    const openBreak = assignment.breaks?.find(b => !b.endedAt);
    if (!openBreak) {
        throw new BadRequestError("You are not currently on a break.");
    }
    openBreak.endedAt = new Date();
    await assignment.save();

    await logActivity({
        job: assignment.job,
        assignment: assignment._id,
        worker: assignment.worker,
        type: "assignment_break_ended",
        actor: req.user.user_id,
    });

    res.status(StatusCodes.OK).json({
        success: true,
        message: "Break ended.",
        assignment,
    });
};

/**
 * GET /workers/recurring-groups
 * Everything a worker needs to respond to recurring shifts in bulk: their
 * upcoming (not-yet-happened) assignments across every recurring job they're
 * on, grouped by series with pending/accepted/declined counts. Past shifts
 * belong on the normal jobs list, not this "respond in bulk" view.
 */
export const getRecurringAssignmentGroups: MiddlewareFn = async (req, res) => {
    const workerId = new mongoose.Types.ObjectId(req.user.user_id);
    const today = toUtcDay(new Date());

    const rows = await JobAssignment.aggregate([
        { $match: { worker: workerId, isDeleted: false, status: { $ne: "cancelled" } } },
        {
            $lookup: {
                from: "jobs",
                let: { jobId: "$job" },
                pipeline: [
                    {
                        $match: {
                            $expr: { $eq: ["$_id", "$$jobId"] },
                            isDeleted: false,
                            recurringJob: { $ne: null },
                            date: { $gte: today },
                            status: { $ne: "cancelled" },
                        },
                    },
                ],
                as: "job",
            },
        },
        { $unwind: "$job" },
        { $sort: { "job.date": 1 } },
        {
            $group: {
                _id: "$job.recurringJob",
                pendingCount: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
                acceptedCount: { $sum: { $cond: [{ $eq: ["$status", "accepted"] }, 1, 0] } },
                declinedCount: { $sum: { $cond: [{ $eq: ["$status", "declined"] }, 1, 0] } },
                shifts: {
                    $push: {
                        jobId: "$job._id",
                        assignmentId: "$_id",
                        date: "$job.date",
                        startTime: "$job.startTime",
                        endTime: "$job.endTime",
                        location: "$job.location",
                        status: "$status",
                    },
                },
            },
        },
    ]);

    if (!rows.length) {
        res.status(StatusCodes.OK).json({ success: true, groups: [] });
        return;
    }

    // Populate via the Mongoose model rather than a raw $lookup on the
    // collection name — avoids having to get RecurringJob's pluralized
    // collection name exactly right.
    const schedules = await recurringJobModel
        .find({ _id: { $in: rows.map(r => r._id) } })
        .populate({
            path: "templateJob",
            select: "title location client startTime endTime",
            populate: { path: "client", select: "name" },
        })
        .lean();
    const scheduleById = new Map(schedules.map(s => [s._id.toString(), s]));

    const groups = rows
        .map(r => {
            const schedule = scheduleById.get(r._id.toString());
            // Schedule was deleted/inaccessible since the assignment was
            // created — skip rather than surface a broken group.
            if (!schedule) return null;
            const template = schedule.templateJob as any;
            const shifts = r.shifts as any[];
            return {
                recurringJobId: r._id,
                title: template?.title ?? "Recurring shift",
                location: template?.location,
                client: template?.client,
                frequency: schedule.frequency,
                interval: schedule.interval,
                daysOfWeek: schedule.daysOfWeek,
                startTime: template?.startTime,
                endTime: template?.endTime,
                pendingCount: r.pendingCount,
                acceptedCount: r.acceptedCount,
                declinedCount: r.declinedCount,
                upcomingCount: shifts.length,
                nextShift: shifts.find(s => s.status === "pending" || s.status === "accepted") ?? null,
                shifts,
            };
        })
        .filter(Boolean);

    res.status(StatusCodes.OK).json({ success: true, groups });
};

// Fire-and-forget: the manager who owns a recurring schedule gets one
// summary notification when a worker responds to a whole series at once —
// same "one email, not N" rule as sendRecurringShiftAssigned on the
// worker-facing side. Gated by the manager's own notification preferences,
// reusing the existing job_accepted/job_declined events rather than adding
// new ones just for the bulk case.
async function notifyManagerOfSeriesResponse({
    recurringJobId,
    workerId,
    type,
    count,
    jobDates,
}: {
    recurringJobId: string;
    workerId: string;
    type: "accepted" | "declined";
    count: number;
    jobDates: Date[];
}) {
    if (!count) return;

    const [schedule, worker] = await Promise.all([
        recurringJobModel
            .findById(recurringJobId)
            .populate<{ createdBy: { _id: mongoose.Types.ObjectId; email: string } }>("createdBy", "email")
            .populate<{ templateJob: { title: string } }>("templateJob", "title")
            .lean(),
        userModel.findById(workerId).select("fullname").lean(),
    ]);
    if (!schedule || !worker) return;

    const manager = schedule.createdBy;
    if (!manager?.email) return;

    const managerId = manager._id.toString();
    const event = type === "accepted" ? "job_accepted" : "job_declined";
    const [canEmail, canPush] = await Promise.all([
        shouldNotify(managerId, event, "email"),
        shouldNotify(managerId, event, "push"),
    ]);

    const sortedDates = [...jobDates].sort((a, b) => a.getTime() - b.getTime());
    const title = schedule.templateJob?.title ?? "Recurring shift";

    await Promise.all([
        canEmail
            ? sendRecurringSeriesResponse({
                manager: { email: manager.email },
                worker: { fullname: worker.fullname },
                job: { title },
                recurringJobId,
                type,
                count,
                firstDate: sortedDates[0],
                lastDate: sortedDates[sortedDates.length - 1],
            })
            : Promise.resolve(),
        canPush
            ? sendPushToUser(managerId, {
                title: type === "accepted" ? "Shifts accepted" : "Shifts declined",
                body: `${worker.fullname} ${type} ${count} shift${count === 1 ? "" : "s"} on ${title}`,
                tag: `recurring-series-${recurringJobId}-${type}`,
                url: `/jobs/recurring/recurring-job-detail/${recurringJobId}`,
            })
            : Promise.resolve(),
    ]);
}

/**
 * PATCH /workers/recurring-jobs/:id/accept-all
 * Accepts every currently-pending assignment in a recurring series at once.
 * Re-checks what's actually pending right now rather than trusting a count
 * the frontend already had cached — another tab, an expired shift, or a
 * manager cancelling one in the meantime are all real races.
 */
export const acceptRecurringSeries: MiddlewareFn = async (req, res) => {
    const { id: recurringJobId } = req.params;
    const workerId = getReqUser(req).user_id;

    const futureJobs = await jobModel.find({
        recurringJob: recurringJobId,
        date: { $gte: new Date() },
        isDeleted: false,
        status: { $ne: "cancelled" },
    }).select("_id date").lean();
    const futureJobIds = futureJobs.map(j => j._id);

    const pendingAssignments = await JobAssignment.find({
        job: { $in: futureJobIds },
        worker: workerId,
        status: "pending",
        isDeleted: false,
    }).select("_id job").lean();

    if (!pendingAssignments.length) {
        res.status(StatusCodes.OK).json({ success: true, accepted: 0 });
        return;
    }

    await JobAssignment.updateMany(
        { _id: { $in: pendingAssignments.map(a => a._id) } },
        { status: "accepted", acceptedAt: new Date() }
    );

    const jobDateById = new Map(futureJobs.map(j => [j._id.toString(), j.date]));
    await logActivityMany(
        pendingAssignments.map(a => ({
            job: a.job,
            jobDate: jobDateById.get(a.job.toString()),
            assignment: a._id,
            worker: workerId,
            type: "assignment_accepted" as const,
            actor: workerId,
        }))
    );

    notifyManagerOfSeriesResponse({
        recurringJobId: String(recurringJobId),
        workerId: String(workerId),
        type: "accepted",
        count: pendingAssignments.length,
        jobDates: pendingAssignments.map(a => jobDateById.get(a.job.toString())).filter((d): d is Date => !!d),
    }).catch(err => console.error(`Failed to notify manager of bulk accept for recurring job ${recurringJobId}:`, err));

    res.status(StatusCodes.OK).json({ success: true, accepted: pendingAssignments.length });
};

/**
 * PATCH /workers/recurring-jobs/:id/decline-all
 * Counterpart to accept-all. Also pulls the worker out of the schedule's
 * defaultWorkers so future auto-generated occurrences stop including them —
 * accepting doesn't do the reverse; re-adding a worker to a schedule is a
 * manager decision, not implied by them accepting what's already there.
 */
export const declineRecurringSeries: MiddlewareFn = async (req, res) => {
    const { id: recurringJobId } = req.params;
    const workerId = getReqUser(req).user_id;

    await recurringJobModel.updateOne(
        { _id: recurringJobId },
        { $pull: { defaultWorkers: workerId } }
    );

    const futureJobs = await jobModel.find({
        recurringJob: recurringJobId,
        date: { $gte: new Date() },
        isDeleted: false,
    }).select("_id date").lean();
    const futureJobIds = futureJobs.map(j => j._id);

    const pendingAssignments = await JobAssignment.find({
        job: { $in: futureJobIds },
        worker: workerId,
        status: "pending",
        isDeleted: false,
    }).select("_id job").lean();

    if (pendingAssignments.length) {
        await JobAssignment.updateMany(
            { _id: { $in: pendingAssignments.map(a => a._id) } },
            { status: "declined", declinedAt: new Date() }
        );

        const jobDateById = new Map(futureJobs.map(j => [j._id.toString(), j.date]));
        await logActivityMany(
            pendingAssignments.map(a => ({
                job: a.job,
                jobDate: jobDateById.get(a.job.toString()),
                assignment: a._id,
                worker: workerId,
                type: "assignment_declined" as const,
                actor: workerId,
            }))
        );

        notifyManagerOfSeriesResponse({
            recurringJobId: String(recurringJobId),
            workerId: String(workerId),
            type: "declined",
            count: pendingAssignments.length,
            jobDates: pendingAssignments.map(a => jobDateById.get(a.job.toString())).filter((d): d is Date => !!d),
        }).catch(err => console.error(`Failed to notify manager of bulk decline for recurring job ${recurringJobId}:`, err));
    }

    res.status(StatusCodes.OK).json({ success: true, declined: pendingAssignments.length });
};
// Body is PushSubscription.toJSON() from the frontend's service worker
// registration — endpoint identifies the device, keys are what web-push
// needs to encrypt notifications for it.
export const savePushSubscription: MiddlewareFn = async (req, res) => {
    const { endpoint, keys } = req.body;

    if (!endpoint || !keys?.p256dh || !keys?.auth) {
        throw new BadRequestError("Invalid push subscription payload.");
    }

    // The $ne guard makes this idempotent — re-subscribing the same device
    // (endpoint) won't create duplicate entries.
    await userModel.updateOne(
        { _id: req.user.user_id, "pushSubscriptions.endpoint": { $ne: endpoint } },
        { $push: { pushSubscriptions: { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } } } }
    );

    res.status(StatusCodes.OK).json({ success: true });
};

// Thin wrapper so there's one route for check-in but no duplicated business logic
export const checkInJob: MiddlewareFn = async (req, res) => {
    req.body.status = "in-progress";
    return updateWorkerJobStatus(req, res, () => { });
};

// GET /workers/open-shifts — published, openToClaims jobs this worker hasn't
// already claimed and that still have an unfilled slot.
export const getOpenShifts: MiddlewareFn = async (req, res) => {
    const companyId = req.user.company_id.toString();
    const workerId = req.user.user_id.toString();
    const today = toUtcDay(new Date());

    const openJobs = await jobModel.find({
        company: companyId,
        isDeleted: false,
        isTemplate: false,
        status: "published",
        openToClaims: true,
        date: { $gte: today },
    })
        .populate("client", "name")
        .sort({ date: 1, startTime: 1 })
        .lean();

    if (!openJobs.length) {
        res.status(StatusCodes.OK).json({ success: true, jobs: [] });
        return;
    }

    const jobIds = openJobs.map(job => job._id);
    const assignmentsByJob = await JobAssignment.aggregate([
        { $match: { job: { $in: jobIds }, isDeleted: false, status: { $nin: ["declined", "cancelled"] } } },
        { $group: { _id: "$job", count: { $sum: 1 }, workers: { $push: "$worker" } } },
    ]);
    const infoByJob = new Map(assignmentsByJob.map(a => [a._id.toString(), a]));

    // A job stays "open" only while it still has an unfilled slot and this
    // worker isn't already on it — claimed-out or already-claimed shifts
    // simply don't show up, rather than showing up disabled.
    const jobs = openJobs.filter(job => {
        const info = infoByJob.get(job._id.toString());
        const filled = info?.count ?? 0;
        const alreadyClaimed = (info?.workers ?? []).some((w: mongoose.Types.ObjectId) => w.toString() === workerId);
        return !alreadyClaimed && filled < (job.requiredWorkers ?? 1);
    });

    res.status(StatusCodes.OK).json({ success: true, jobs });
};

// POST /workers/open-shifts/:jobId/claim
export const claimOpenShift: MiddlewareFn = async (req, res) => {
    const jobId = req.params.jobId as string;
    if (!mongoose.Types.ObjectId.isValid(jobId)) {
        throw new BadRequestError("Invalid job id.");
    }

    const companyId = req.user.company_id.toString();
    const workerId = req.user.user_id;
    const today = toUtcDay(new Date());

    const job = await jobModel.findOne({
        _id: jobId,
        company: companyId,
        isDeleted: false,
        isTemplate: false,
        status: "published",
        openToClaims: true,
        date: { $gte: today },
    }).lean();
    if (!job) throw new NotFoundError("This shift is no longer available to claim.");

    const existing = await JobAssignment.findOne({ job: jobId, worker: workerId, isDeleted: false });
    if (existing) throw new BadRequestError("You've already claimed this shift.");

    // Check-then-insert, not a transaction — claiming is a human-paced,
    // low-frequency action here, not a high-contention queue, and the
    // {job, worker} unique index still blocks the one race that actually
    // matters (the same worker double-claiming from two tabs).
    const activeCount = await JobAssignment.countDocuments({
        job: jobId,
        isDeleted: false,
        status: { $nin: ["declined", "cancelled"] },
    });
    if (activeCount >= (job.requiredWorkers ?? 1)) {
        throw new BadRequestError("This shift has just been filled by someone else.");
    }

    const worker = await userModel.findById(workerId).select("fullname email");
    if (!worker) throw new UnauthenticatedError("Login again.");

    const needsApproval = job.requiresApproval !== false;
    const now = new Date();

    let assignment;
    try {
        assignment = await JobAssignment.create({
            fullname: worker.fullname,
            job: job._id,
            worker: workerId,
            createdBy: workerId,
            company: companyId,
            status: needsApproval ? "pending" : "accepted",
            pendingApproval: needsApproval,
            ...(needsApproval ? {} : { acceptedAt: now }),
        });
    } catch (err: any) {
        if (err?.code === 11000) throw new BadRequestError("You've already claimed this shift.");
        throw err;
    }

    const manager = await userModel.findById(job.createdBy).select("email");
    if (manager?.email) {
        sendOpenShiftClaimNotice({
            managerEmail: manager.email,
            workerFullname: worker.fullname,
            job: {
                _id: job._id.toString(),
                title: job.title,
                date: job.date,
                startTime: job.startTime,
                endTime: job.endTime,
            },
            needsApproval,
        }).catch(err => console.error("Failed to send open-shift claim notice:", err));
    }

    await logActivity({
        job: job._id,
        jobDate: job.date,
        assignment: assignment._id,
        worker: workerId,
        type: "assignment_claimed",
        actor: workerId,
        metadata: { needsApproval },
    });

    res.status(StatusCodes.CREATED).json({ success: true, assignment, needsApproval });
};

// PATCH /workers/assignments/:assignmentId/claim-review — admin/manager only.
// Approves or declines a self-claim on a job whose requiresApproval is true.
export const reviewOpenShiftClaim: MiddlewareFn = async (req, res) => {
    const { assignmentId } = req.params;
    const { approve } = req.body;
    if (typeof approve !== "boolean") {
        throw new BadRequestError("approve must be true or false.");
    }

    const assignment = await JobAssignment.findOne({
        _id: assignmentId,
        isDeleted: false,
        pendingApproval: true,
    });
    if (!assignment) throw new NotFoundError("No pending claim found for this assignment.");

    const job = await jobModel.findOne({ _id: assignment.job, isDeleted: false });
    if (!job || job.company.toString() !== req.user.company_id.toString()) {
        throw new NotFoundError("No pending claim found for this assignment.");
    }

    const now = new Date();
    if (approve) {
        assignment.status = "accepted";
        assignment.acceptedAt = now;
    } else {
        assignment.status = "declined";
        assignment.declinedAt = now;
        assignment.cancellationReason = "Claim declined by manager";
    }
    assignment.pendingApproval = false;
    await assignment.save();

    await logActivity({
        job: job._id,
        jobDate: job.date,
        assignment: assignment._id,
        worker: assignment.worker,
        type: approve ? "assignment_claim_approved" : "assignment_claim_declined",
        actor: req.user.user_id,
    });

    const worker = await userModel.findById(assignment.worker).select("fullname email");
    if (worker?.email) {
        sendClaimReviewResultEmail({
            email: worker.email,
            fullname: worker.fullname,
            job: {
                _id: job._id.toString(),
                title: job.title,
                date: job.date,
                startTime: job.startTime,
                endTime: job.endTime,
            },
            approved: approve,
        }).catch(err => console.error("Failed to send claim-review result email:", err));
    }

    res.status(StatusCodes.OK).json({ success: true, assignment });
};