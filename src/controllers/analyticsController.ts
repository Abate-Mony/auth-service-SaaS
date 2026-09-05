import { StatusCodes } from "http-status-codes";
import type { Dayjs } from "dayjs";
import dayjs from "../utils/dayjsSetup.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import { BadRequestError } from "../errors/customErrors.js";
import jobModel from "../models/jobModel.js";
import JobAssignment from "../models/JobAssignment.js";
import Company from "../models/company.js";
import userModel from "../models/userModel.js";
import { scheduledEndOf, scheduledStartOf, TZ } from "../utils/dates.js";

type RangeKey = "7d" | "30d" | "90d" | "year";
const RANGE_KEYS: RangeKey[] = ["7d", "30d", "90d", "year"];

type LeanJob = {
  _id: string;
  date: Date;
  startTime: string;
  endTime: string;
  minutes: number;
  location: string;
  status: string;
};

type LeanAssignment = {
  _id: string;
  job: string;
  worker: string;
  status: string;
  checkedInAt?: Date | null;
  checkedOutAt?: Date | null;
  breaks?: { startedAt?: Date | null; endedAt?: Date | null }[];
  approvedMinutes?: number | null;
  overtimeMinutes?: number;
  overtimeStatus?: string;
};

// Same "worked minutes, net of breaks" arithmetic used elsewhere (worker
// stats, timesheets) — kept local rather than shared, matching how this
// codebase already has this calc duplicated per-controller rather than
// factored into one utils module.
const workedMinutesOf = (a: LeanAssignment): number => {
  if (!a.checkedInAt || !a.checkedOutAt) return 0;
  const gross = dayjs(a.checkedOutAt).diff(dayjs(a.checkedInAt), "minute");
  const breakMins = (a.breaks ?? []).reduce((sum, b) => {
    if (!b.startedAt || !b.endedAt) return sum;
    return sum + dayjs(b.endedAt).diff(dayjs(b.startedAt), "minute");
  }, 0);
  return Math.max(0, gross - breakMins);
};

const payableMinutesOf = (a: LeanAssignment): number =>
  a.approvedMinutes != null ? a.approvedMinutes : workedMinutesOf(a);

const overtimeSplitOf = (a: LeanAssignment): { regular: number; overtime: number } => {
  const payable = payableMinutesOf(a);
  const approvedOvertime = a.overtimeStatus === "approved" ? (a.overtimeMinutes ?? 0) : 0;
  return { regular: Math.max(0, payable - approvedOvertime), overtime: approvedOvertime };
};

// Assignment status collapsed to the 4 buckets the dashboard shows —
// "Scheduled" covers anything still ahead of the worker (pending/accepted),
// "Cancelled" covers anything that fell through (declined/cancelled).
const statusBucketOf = (status: string): "completed" | "in-progress" | "scheduled" | "cancelled" => {
  if (status === "completed") return "completed";
  if (status === "in-progress") return "in-progress";
  if (status === "declined" || status === "cancelled") return "cancelled";
  return "scheduled";
};

const percentDelta = (current: number, prior: number): number | null => {
  if (prior === 0) return current === 0 ? 0 : null;
  return Math.round(((current - prior) / prior) * 100);
};

interface RangeConfig {
  start: Dayjs;
  end: Dayjs;
  priorStart: Dayjs;
  priorEnd: Dayjs;
  bucketCount: number;
  labelFormat: string;
}

const getRangeConfig = (range: RangeKey, tz: string): RangeConfig => {
  const now = dayjs().tz(tz);
  const end = now.endOf("day");

  if (range === "year") {
    const start = now.startOf("year");
    const priorEnd = start.subtract(1, "millisecond");
    const priorStart = priorEnd.subtract(now.diff(start, "month") + 1, "month").startOf("month");
    return {
      start,
      end,
      priorStart,
      priorEnd,
      bucketCount: Math.max(1, now.diff(start, "month") + 1),
      labelFormat: "MMM",
    };
  }

  const daysByRange: Record<Exclude<RangeKey, "year">, number> = { "7d": 7, "30d": 30, "90d": 90 };
  const bucketsByRange: Record<Exclude<RangeKey, "year">, number> = { "7d": 7, "30d": 4, "90d": 3 };
  const days = daysByRange[range];

  const start = end.subtract(days - 1, "day").startOf("day");
  const priorEnd = start.subtract(1, "millisecond");
  const priorStart = priorEnd.subtract(days - 1, "day").startOf("day");

  return {
    start,
    end,
    priorStart,
    priorEnd,
    bucketCount: bucketsByRange[range],
    labelFormat: range === "7d" ? "ddd" : "D MMM",
  };
};

// Equal-width buckets spanning [start, end] — used for both the current and
// prior period so the two line up point-for-point on the trend chart
// regardless of how unevenly a real calendar week/month would divide.
const buildBuckets = (start: Dayjs, end: Dayjs, count: number, labelFormat: string) => {
  const totalMs = end.diff(start);
  const step = totalMs / count;
  return Array.from({ length: count }, (_, i) => {
    const bStart = start.add(Math.round(step * i), "millisecond");
    const bEnd = i === count - 1 ? end : start.add(Math.round(step * (i + 1)), "millisecond");
    return { start: bStart, end: bEnd, label: bStart.format(labelFormat) };
  });
};

const bucketIndexFor = (date: Dayjs, buckets: { start: Dayjs; end: Dayjs }[]): number =>
  buckets.findIndex((b, i) => (i === buckets.length - 1 ? !date.isBefore(b.start) : date.isSameOrAfter(b.start) && date.isBefore(b.end)));

export const getAnalytics: MiddlewareFn = async (req, res) => {
  const range = (req.query.range as string) ?? "7d";
  if (!RANGE_KEYS.includes(range as RangeKey)) {
    throw new BadRequestError("range must be one of 7d, 30d, 90d, year");
  }

  const companyId = req.user.company_id.toString();
  const company = await Company.findById(companyId).select("timezone clockInGraceMinutes").lean();
  const tz = company?.timezone ?? TZ;
  const graceMs = (company?.clockInGraceMinutes ?? 30) * 60_000;

  const { start, end, priorStart, priorEnd, bucketCount, labelFormat } = getRangeConfig(range as RangeKey, tz);
  const currentBuckets = buildBuckets(start, end, bucketCount, labelFormat);
  const priorBuckets = buildBuckets(priorStart, priorEnd, bucketCount, labelFormat);

  // ── Main range: everything except the two fixed-window panels below ────
  const rangeJobs = await jobModel
    .find({
      company: companyId,
      isDeleted: false,
      isTemplate: false,
      date: { $gte: priorStart.toDate(), $lte: end.toDate() },
    })
    .select("date startTime endTime minutes location status")
    .lean<LeanJob[]>();

  const rangeJobIds = rangeJobs.map(j => j._id);
  const jobById = new Map(rangeJobs.map(j => [j._id.toString(), j]));

  const rangeAssignments = rangeJobIds.length
    ? await JobAssignment.find({ job: { $in: rangeJobIds }, isDeleted: false })
        .select("job worker status checkedInAt checkedOutAt breaks approvedMinutes overtimeMinutes overtimeStatus")
        .lean<LeanAssignment[]>()
    : [];

  let totalHoursMinutes = 0;
  let priorTotalHoursMinutes = 0;
  let completedCount = 0;
  let priorCompletedCount = 0;
  let inProgressCount = 0;
  let scheduledCount = 0;
  let cancelledCount = 0;
  let totalCount = 0;
  let priorTotalCount = 0;
  const activeWorkers = new Set<string>();
  const priorActiveWorkers = new Set<string>();
  let overtimeMinutesTotal = 0;

  const hoursCurrent = new Array(bucketCount).fill(0);
  const hoursPrior = new Array(bucketCount).fill(0);

  const workerAgg = new Map<string, { minutes: number; completed: number; total: number }>();
  const locationAgg = new Map<string, { jobs: Set<string>; minutes: number; completed: number; total: number }>();
  const dayOfWeekMinutes = [0, 0, 0, 0, 0, 0, 0]; // Mon..Sun
  const shiftLengths: number[] = [];

  for (const a of rangeAssignments) {
    const job = jobById.get(a.job.toString());
    if (!job) continue;
    const jobDate = dayjs(job.date).tz(tz);
    const isCurrent = !jobDate.isBefore(start) && !jobDate.isAfter(end);
    const isPrior = !jobDate.isBefore(priorStart) && !jobDate.isAfter(priorEnd);
    if (!isCurrent && !isPrior) continue;

    const minutes = payableMinutesOf(a);

    if (isCurrent) {
      totalHoursMinutes += minutes;
      totalCount++;
      activeWorkers.add(a.worker.toString());

      const bucket = statusBucketOf(a.status);
      if (bucket === "completed") completedCount++;
      else if (bucket === "in-progress") inProgressCount++;
      else if (bucket === "scheduled") scheduledCount++;
      else cancelledCount++;

      const idx = bucketIndexFor(jobDate, currentBuckets);
      if (idx >= 0) hoursCurrent[idx] += minutes / 60;

      const { overtime } = overtimeSplitOf(a);
      overtimeMinutesTotal += overtime;

      if (minutes > 0) {
        shiftLengths.push(minutes);
        dayOfWeekMinutes[(jobDate.isoWeekday() ?? 1) - 1] += minutes;
      }

      const worker = workerAgg.get(a.worker.toString()) ?? { minutes: 0, completed: 0, total: 0 };
      worker.minutes += minutes;
      worker.total++;
      if (bucket === "completed") worker.completed++;
      workerAgg.set(a.worker.toString(), worker);

      const loc = job.location || "Unspecified";
      const locEntry = locationAgg.get(loc) ?? { jobs: new Set<string>(), minutes: 0, completed: 0, total: 0 };
      locEntry.jobs.add(job._id.toString());
      locEntry.minutes += minutes;
      locEntry.total++;
      if (bucket === "completed") locEntry.completed++;
      locationAgg.set(loc, locEntry);
    } else {
      priorTotalHoursMinutes += minutes;
      priorTotalCount++;
      priorActiveWorkers.add(a.worker.toString());
      if (statusBucketOf(a.status) === "completed") priorCompletedCount++;

      const idx = bucketIndexFor(jobDate, priorBuckets);
      if (idx >= 0) hoursPrior[idx] += minutes / 60;
    }
  }

  const completionRate = totalCount ? Math.round((completedCount / totalCount) * 100) : null;
  const priorCompletionRate = priorTotalCount ? Math.round((priorCompletedCount / priorTotalCount) * 100) : null;

  const topWorkerIds = [...workerAgg.entries()]
    .sort((a, b) => b[1].minutes - a[1].minutes)
    .slice(0, 5)
    .map(([id]) => id);
  const topWorkerUsers = topWorkerIds.length
    ? await userModel.find({ _id: { $in: topWorkerIds } }).select("fullname").lean()
    : [];
  const nameById = new Map(topWorkerUsers.map(u => [u._id.toString(), u.fullname]));

  const topWorkers = topWorkerIds.map(id => {
    const w = workerAgg.get(id)!;
    return {
      workerId: id,
      fullname: nameById.get(id) ?? "Unknown",
      hours: Math.round((w.minutes / 60) * 10) / 10,
      jobs: w.total,
      completionRate: w.total ? Math.round((w.completed / w.total) * 100) : 0,
    };
  });

  const locationPerformance = [...locationAgg.entries()]
    .map(([location, v]) => ({
      location,
      jobs: v.jobs.size,
      hours: Math.round((v.minutes / 60) * 10) / 10,
      completionRate: v.total ? Math.round((v.completed / v.total) * 100) : 0,
    }))
    .sort((a, b) => b.hours - a.hours)
    .slice(0, 8);

  const peakDayIdx = dayOfWeekMinutes.reduce((best, m, i) => (m > dayOfWeekMinutes[best] ? i : best), 0);
  const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const avgShiftMinutes = shiftLengths.length
    ? Math.round(shiftLengths.reduce((s, m) => s + m, 0) / shiftLengths.length)
    : 0;
  const overtimeRate = totalHoursMinutes ? Math.round((overtimeMinutesTotal / totalHoursMinutes) * 1000) / 10 : 0;

  // ── Fixed window: worker clock-in activity, always the last 7 days ─────
  const activityStart = dayjs().tz(tz).subtract(6, "day").startOf("day");
  const activityEnd = dayjs().tz(tz).endOf("day");
  const activityJobs = await jobModel
    .find({
      company: companyId,
      isDeleted: false,
      isTemplate: false,
      date: { $gte: activityStart.toDate(), $lte: activityEnd.toDate() },
    })
    .select("date startTime endTime minutes")
    .lean<LeanJob[]>();
  const activityJobIds = activityJobs.map(j => j._id);
  const activityJobById = new Map(activityJobs.map(j => [j._id.toString(), j]));
  const activityAssignments = activityJobIds.length
    ? await JobAssignment.find({
        job: { $in: activityJobIds },
        isDeleted: false,
        status: { $in: ["accepted", "in-progress", "completed"] },
      })
        .select("job status checkedInAt")
        .lean<LeanAssignment[]>()
    : [];

  const activityDays = Array.from({ length: 7 }, (_, i) => {
    const d = activityStart.add(i, "day");
    return { label: d.format("ddd"), date: d, onTime: 0, late: 0, noShow: 0 };
  });
  const now = dayjs().tz(tz);
  for (const a of activityAssignments) {
    const job = activityJobById.get(a.job.toString());
    if (!job) continue;
    const jobDate = dayjs(job.date).tz(tz);
    const dayEntry = activityDays.find(d => d.date.isSame(jobDate, "day"));
    if (!dayEntry) continue;

    if (a.checkedInAt) {
      const scheduledStart = scheduledStartOf(job, tz);
      if (a.checkedInAt.getTime() <= scheduledStart.getTime() + graceMs) dayEntry.onTime++;
      else dayEntry.late++;
    } else {
      const scheduledEnd = scheduledEndOf(job, tz);
      if (now.isAfter(scheduledEnd)) dayEntry.noShow++;
    }
  }

  // ── Fixed window: regular vs overtime, always the last 4 weeks ─────────
  const overtimeWindowStart = dayjs().tz(tz).subtract(27, "day").startOf("day");
  const overtimeJobs = await jobModel
    .find({
      company: companyId,
      isDeleted: false,
      isTemplate: false,
      date: { $gte: overtimeWindowStart.toDate(), $lte: end.toDate() },
    })
    .select("date")
    .lean<LeanJob[]>();
  const overtimeJobById = new Map(overtimeJobs.map(j => [j._id.toString(), j]));
  const overtimeJobIds = overtimeJobs.map(j => j._id);
  const overtimeAssignments = overtimeJobIds.length
    ? await JobAssignment.find({ job: { $in: overtimeJobIds }, isDeleted: false, status: "completed" })
        .select("job checkedInAt checkedOutAt breaks approvedMinutes overtimeMinutes overtimeStatus")
        .lean<LeanAssignment[]>()
    : [];

  const overtimeWeeks = Array.from({ length: 4 }, (_, i) => {
    const wStart = overtimeWindowStart.add(i * 7, "day");
    return { label: `W${i + 1}`, start: wStart, end: wStart.add(7, "day"), regular: 0, overtime: 0 };
  });
  for (const a of overtimeAssignments) {
    const job = overtimeJobById.get(a.job.toString());
    if (!job) continue;
    const jobDate = dayjs(job.date).tz(tz);
    const week = overtimeWeeks.find(w => jobDate.isSameOrAfter(w.start) && jobDate.isBefore(w.end)) ?? overtimeWeeks[3];
    const { regular, overtime } = overtimeSplitOf(a);
    week.regular += regular / 60;
    week.overtime += overtime / 60;
  }

  res.status(StatusCodes.OK).json({
    success: true,
    range,
    period: { start: start.toISOString(), end: end.toISOString() },
    kpis: {
      totalHours: {
        value: Math.round(totalHoursMinutes / 60),
        deltaPercent: percentDelta(totalHoursMinutes, priorTotalHoursMinutes),
      },
      jobsCompleted: {
        value: completedCount,
        deltaPercent: percentDelta(completedCount, priorCompletedCount),
      },
      activeWorkers: {
        value: activeWorkers.size,
        deltaPercent: percentDelta(activeWorkers.size, priorActiveWorkers.size),
      },
      completionRate: {
        value: completionRate,
        deltaPercent:
          completionRate === null || priorCompletionRate === null
            ? null
            : completionRate - priorCompletionRate,
      },
    },
    hoursTrend: currentBuckets.map((b, i) => ({
      label: b.label,
      hours: Math.round(hoursCurrent[i] * 10) / 10,
      priorHours: Math.round(hoursPrior[i] * 10) / 10,
    })),
    jobStatusBreakdown: [
      { status: "completed", label: "Completed", count: completedCount },
      { status: "in-progress", label: "In Progress", count: inProgressCount },
      { status: "scheduled", label: "Scheduled", count: scheduledCount },
      { status: "cancelled", label: "Cancelled", count: cancelledCount },
    ],
    workerClockInActivity: activityDays.map(d => ({ label: d.label, onTime: d.onTime, late: d.late, noShow: d.noShow })),
    regularVsOvertime: overtimeWeeks.map(w => ({
      label: w.label,
      regular: Math.round(w.regular * 10) / 10,
      overtime: Math.round(w.overtime * 10) / 10,
    })),
    topWorkers,
    locationPerformance,
    insights: {
      peakDay: shiftLengths.length ? DAY_NAMES[peakDayIdx] : null,
      avgShiftMinutes,
      overtimeRatePercent: overtimeRate,
    },
  });
};
