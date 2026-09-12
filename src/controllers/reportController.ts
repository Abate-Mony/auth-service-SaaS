import type { Request } from "express";
import { StatusCodes } from "http-status-codes";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import { BadRequestError } from "../errors/customErrors.js";
import dayjs from "../utils/dayjsSetup.js";
import jobModel from "../models/jobModel.js";
import JobAssignment from "../models/JobAssignment.js";
import userModel from "../models/userModel.js";
import Company from "../models/company.js";
import Invoice from "../models/invoiceModel.js";
import Client from "../models/clientModel.js";
import { TZ, toUtcDay } from "../utils/dates.js";
import { assertFeatureEnabledForCompany } from "../utils/planLimits.js";

// ── Shared helpers ─────────────────────────────────────────────────────────
// Same "worked minutes, net of breaks" / "payable minutes" arithmetic as
// timesheetController.ts and analyticsController.ts — kept local rather than
// factored into a shared util, matching how this codebase already has this
// calc duplicated per-controller.

type LeanJob = {
  _id: string;
  title: string;
  date: Date;
  startTime: string;
  endTime: string;
  status: string;
};

type LeanAssignment = {
  _id: string;
  job: string;
  worker: string;
  fullname: string;
  status: string;
  checkedInAt?: Date | null;
  checkedOutAt?: Date | null;
  breaks?: { startedAt?: Date | null; endedAt?: Date | null }[];
  approvedMinutes?: number | null;
  overtimeMinutes?: number;
  overtimeStatus?: string;
  payRate?: number;
};

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

// Only manager-approved overtime counts as "overtime" for reporting —
// anything still pending review is already excluded from payableMinutes
// (capped at the scheduled amount), so it isn't double-counted here.
const overtimeSplitOf = (a: LeanAssignment): { regularMinutes: number; overtimeMinutes: number } => {
  const payable = payableMinutesOf(a);
  const overtime = a.overtimeStatus === "approved" ? (a.overtimeMinutes ?? 0) : 0;
  return { regularMinutes: Math.max(0, payable - overtime), overtimeMinutes: overtime };
};

const parseRange = (req: Request): { start: Date; end: Date } => {
  const { start, end } = req.query as { start?: string; end?: string };
  if (!start || !end) throw new BadRequestError("start and end query params are required");

  // Job.date is always normalised to UTC midnight (see utils/dates.ts) —
  // a server-local-time day boundary here would shift by the server's UTC
  // offset and could silently include/exclude a job on the first or last
  // day of the requested range.
  let startDate: Date, endDate: Date;
  try {
    startDate = toUtcDay(start);
    endDate = toUtcDay(end);
  } catch {
    throw new BadRequestError("Invalid start or end date");
  }
  if (dayjs(endDate).isBefore(startDate)) throw new BadRequestError("end cannot be before start");

  return { start: startDate, end: endDate };
};

// Every report tab starts from the same "which jobs, which assignments"
// query — company-scoped, real shifts only (no drafts/templates), within
// the requested range.
const getJobsAndAssignments = async (companyId: string, start: Date, end: Date) => {
  const jobs = await jobModel
    .find({
      company: companyId,
      isDeleted: false,
      isTemplate: false,
      status: { $ne: "draft" },
      date: { $gte: start, $lte: end },
    })
    .select("title date startTime endTime status")
    .lean<LeanJob[]>();

  const jobIds = jobs.map(j => j._id);
  const jobById = new Map(jobs.map(j => [j._id.toString(), j]));

  const assignments = jobIds.length
    ? await JobAssignment.find({ job: { $in: jobIds }, isDeleted: false })
        .select("job worker fullname status checkedInAt checkedOutAt breaks approvedMinutes overtimeMinutes overtimeStatus payRate")
        .lean<LeanAssignment[]>()
    : [];

  return { jobs, jobById, assignments };
};

/**
 * GET /api/v1/reports/overview?start=&end=
 * Powers the Reports > Overview tab: headline stats, a trailing 6-month
 * hours trend, the job-status split, and this-week's daily hours.
 */
export const getReportsOverview: MiddlewareFn = async (req, res) => {
  const companyId = req.user.company_id.toString();
  const { start, end } = parseRange(req);
  const company = await Company.findById(companyId).select("timezone").lean();
  const tz = company?.timezone ?? TZ;

  const { jobs, assignments } = await getJobsAndAssignments(companyId, start, end);

  let totalMinutes = 0;
  const activeWorkers = new Set<string>();
  const statusCounts: Record<string, number> = { published: 0, completed: 0, cancelled: 0 };

  for (const j of jobs) {
    if (j.status in statusCounts) statusCounts[j.status]++;
  }
  for (const a of assignments) {
    totalMinutes += payableMinutesOf(a);
    if (a.checkedInAt) activeWorkers.add(a.worker.toString());
  }

  const totalHours = totalMinutes / 60;
  const jobsCompleted = statusCounts.completed;

  // ── Trailing 6-month trend (independent of the selected range's span —
  // always the 6 calendar months ending at the selected range's end) ──────
  const trendEnd = dayjs(end).tz(tz).endOf("month");
  const trendStart = trendEnd.subtract(5, "month").startOf("month");
  const trendJobs = await jobModel
    .find({
      company: companyId,
      isDeleted: false,
      isTemplate: false,
      status: { $ne: "draft" },
      date: { $gte: trendStart.toDate(), $lte: trendEnd.toDate() },
    })
    .select("date status")
    .lean<Pick<LeanJob, "_id" | "date" | "status">[]>();
  const trendJobIds = trendJobs.map(j => j._id);
  const trendJobById = new Map(trendJobs.map(j => [j._id.toString(), j]));
  const trendAssignments = trendJobIds.length
    ? await JobAssignment.find({ job: { $in: trendJobIds }, isDeleted: false })
        .select("job checkedInAt checkedOutAt breaks approvedMinutes")
        .lean<LeanAssignment[]>()
    : [];

  const months = Array.from({ length: 6 }, (_, i) => trendStart.add(i, "month"));
  const monthlyTrend = months.map(m => ({ label: m.format("MMM"), hours: 0, jobs: 0 }));
  for (const j of trendJobs) {
    if (j.status !== "completed") continue;
    const idx = months.findIndex(m => dayjs(j.date).tz(tz).isSame(m, "month"));
    if (idx >= 0) monthlyTrend[idx].jobs++;
  }
  for (const a of trendAssignments) {
    const job = trendJobById.get(a.job.toString());
    if (!job) continue;
    const idx = months.findIndex(m => dayjs(job.date).tz(tz).isSame(m, "month"));
    if (idx >= 0) monthlyTrend[idx].hours += payableMinutesOf(a) / 60;
  }
  monthlyTrend.forEach(m => { m.hours = Math.round(m.hours * 10) / 10; });

  // ── This week's daily hours (always the current calendar week, same as
  // the original UI's intent — independent of the selected month) ────────
  const weekStart = dayjs().tz(tz).startOf("week");
  const weekEnd = dayjs().tz(tz).endOf("week");
  const weekJobs = await jobModel
    .find({
      company: companyId,
      isDeleted: false,
      isTemplate: false,
      date: { $gte: weekStart.toDate(), $lte: weekEnd.toDate() },
    })
    .select("date")
    .lean<Pick<LeanJob, "_id" | "date">[]>();
  const weekJobById = new Map(weekJobs.map(j => [j._id.toString(), j]));
  const weekJobIds = weekJobs.map(j => j._id);
  const weekAssignments = weekJobIds.length
    ? await JobAssignment.find({ job: { $in: weekJobIds }, isDeleted: false })
        .select("job checkedInAt checkedOutAt breaks approvedMinutes")
        .lean<LeanAssignment[]>()
    : [];
  const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dailyHours = Array.from({ length: 7 }, (_, i) => ({
    day: DAY_LABELS[weekStart.add(i, "day").day()],
    hours: 0,
  }));
  for (const a of weekAssignments) {
    const job = weekJobById.get(a.job.toString());
    if (!job) continue;
    const dayIdx = dayjs(job.date).tz(tz).diff(weekStart, "day");
    if (dayIdx >= 0 && dayIdx < 7) dailyHours[dayIdx].hours += payableMinutesOf(a) / 60;
  }
  dailyHours.forEach(d => { d.hours = Math.round(d.hours * 10) / 10; });

  res.status(StatusCodes.OK).json({
    success: true,
    stats: {
      totalHours: Math.round(totalHours * 10) / 10,
      jobsCompleted,
      activeWorkers: activeWorkers.size,
      avgHoursPerWorker: activeWorkers.size ? Math.round((totalHours / activeWorkers.size) * 10) / 10 : 0,
    },
    monthlyTrend,
    jobStatusBreakdown: [
      { status: "completed", label: "Completed", count: statusCounts.completed },
      { status: "published", label: "Published", count: statusCounts.published },
      { status: "cancelled", label: "Cancelled", count: statusCounts.cancelled },
    ],
    dailyHours,
  });
};

/**
 * GET /api/v1/reports/payroll?start=&end=
 * One row per worker who did any completed, paid work in the range — hours,
 * an effective rate, overtime, and total pay (regular + 1.5x overtime).
 */
export const getReportsPayroll: MiddlewareFn = async (req, res) => {
  const companyId = req.user.company_id.toString();
  const { start, end } = parseRange(req);

  const { assignments } = await getJobsAndAssignments(companyId, start, end);
  const completed = assignments.filter(a => a.status === "completed");

  const byWorker = new Map<string, {
    fullname: string;
    regularMinutes: number;
    overtimeMinutes: number;
    regularPay: number;
    overtimePay: number;
  }>();

  for (const a of completed) {
    const key = a.worker.toString();
    const entry = byWorker.get(key) ?? {
      fullname: a.fullname,
      regularMinutes: 0,
      overtimeMinutes: 0,
      regularPay: 0,
      overtimePay: 0,
    };
    const { regularMinutes, overtimeMinutes } = overtimeSplitOf(a);
    const rate = a.payRate ?? 0;
    entry.regularMinutes += regularMinutes;
    entry.overtimeMinutes += overtimeMinutes;
    entry.regularPay += (regularMinutes / 60) * rate;
    entry.overtimePay += (overtimeMinutes / 60) * rate * 1.5;
    byWorker.set(key, entry);
  }

  const workers = [...byWorker.entries()].map(([workerId, w]) => {
    const hours = (w.regularMinutes + w.overtimeMinutes) / 60;
    const totalPay = w.regularPay + w.overtimePay;
    // Derived, not independently guessed — divides the real totals above,
    // so it never disagrees with totalPay's own math.
    const effectiveRate = w.regularMinutes ? w.regularPay / (w.regularMinutes / 60) : 0;
    return {
      workerId,
      fullname: w.fullname,
      hours: Math.round(hours * 10) / 10,
      rate: Math.round(effectiveRate * 100) / 100,
      overtimeHours: Math.round((w.overtimeMinutes / 60) * 10) / 10,
      totalPay: Math.round(totalPay * 100) / 100,
    };
  }).sort((a, b) => b.totalPay - a.totalPay);

  const userIds = workers.map(w => w.workerId);
  const users = userIds.length
    ? await userModel.find({ _id: { $in: userIds } }).select("email").lean()
    : [];
  const emailById = new Map(users.map(u => [u._id.toString(), u.email]));
  const workersWithEmail = workers.map(w => ({ ...w, email: emailById.get(w.workerId) ?? "" }));

  res.status(StatusCodes.OK).json({
    success: true,
    workers: workersWithEmail,
    totalPayout: Math.round(workersWithEmail.reduce((s, w) => s + w.totalPay, 0) * 100) / 100,
  });
};

/**
 * GET /api/v1/reports/timesheets?start=&end=
 * One row per completed shift in the range, actual clocked times (not the
 * scheduled ones) — this is what a timesheet is for.
 */
export const getReportsTimesheets: MiddlewareFn = async (req, res) => {
  const companyId = req.user.company_id.toString();
  const { start, end } = parseRange(req);
  const company = await Company.findById(companyId).select("timezone").lean();
  const tz = company?.timezone ?? TZ;

  const { jobById, assignments } = await getJobsAndAssignments(companyId, start, end);

  const rows = assignments
    .filter(a => a.status === "completed" && a.checkedInAt && a.checkedOutAt)
    .map(a => {
      const job = jobById.get(a.job.toString());
      const minutes = payableMinutesOf(a);
      return {
        assignmentId: a._id,
        worker: a.fullname,
        job: job?.title ?? "Shift",
        date: job ? dayjs(job.date).tz(tz).format("YYYY-MM-DD") : null,
        start: dayjs(a.checkedInAt).tz(tz).format("HH:mm"),
        finish: dayjs(a.checkedOutAt).tz(tz).format("HH:mm"),
        hours: Math.round((minutes / 60) * 10) / 10,
        sortKey: a.checkedInAt as Date,
      };
    })
    .sort((a, b) => b.sortKey.getTime() - a.sortKey.getTime())
    .map(({ sortKey, ...row }) => row);

  res.status(StatusCodes.OK).json({ success: true, rows });
};

/**
 * GET /api/v1/reports/performance?start=&end=
 * Hours + completed-job count per worker — no ratings, since nothing in
 * this app tracks a worker rating.
 */
export const getReportsPerformance: MiddlewareFn = async (req, res) => {
  const companyId = req.user.company_id.toString();
  await assertFeatureEnabledForCompany(companyId, "advancedReports");
  const { start, end } = parseRange(req);

  const { assignments } = await getJobsAndAssignments(companyId, start, end);

  const byWorker = new Map<string, { fullname: string; minutes: number; jobsCompleted: number }>();
  for (const a of assignments) {
    const key = a.worker.toString();
    const entry = byWorker.get(key) ?? { fullname: a.fullname, minutes: 0, jobsCompleted: 0 };
    entry.minutes += payableMinutesOf(a);
    if (a.status === "completed") entry.jobsCompleted++;
    byWorker.set(key, entry);
  }

  const workers = [...byWorker.entries()]
    .map(([workerId, w]) => ({
      workerId,
      fullname: w.fullname,
      hours: Math.round((w.minutes / 60) * 10) / 10,
      jobsCompleted: w.jobsCompleted,
    }))
    .sort((a, b) => b.hours - a.hours);

  res.status(StatusCodes.OK).json({ success: true, workers });
};

type LeanProfitabilityJob = { _id: string; date: Date; client: string | null };
type LeanInvoice = {
  _id: string;
  client: string | null;
  clientSnapshot?: { name?: string };
  subtotal?: number;
  issueDate?: Date;
  paidAt?: Date | null;
};

/**
 * GET /api/v1/reports/profitability?start=&end=&basis=invoiced|collected&clientId=
 *
 * Revenue from real invoices, labour cost from real approved worked time —
 * split by client, not just a company-wide total. Two revenue bases answer
 * two different questions: "invoiced" is anything billed in the period
 * (issueDate) regardless of payment — how profitable the work was;
 * "collected" is cash that actually arrived in the period (paidAt) — how
 * much money came in. A draft invoice isn't revenue yet; a cancelled one
 * never was.
 *
 * Deliberately stops at gross profit. This app has no visibility into
 * office rent, insurance, software subscriptions, etc. — it can't honestly
 * claim to know net profit, so it doesn't call this "net" anything.
 */
export const getReportsProfitability: MiddlewareFn = async (req, res) => {
  const companyId = req.user.company_id.toString();
  await assertFeatureEnabledForCompany(companyId, "advancedReports");
  const { start, end } = parseRange(req);
  const basis = req.query.basis === "collected" ? "collected" : "invoiced";
  const clientIdFilter =
    typeof req.query.clientId === "string" && req.query.clientId ? req.query.clientId : undefined;

  const invoiceMatch: Record<string, unknown> = { company: companyId, isDeleted: false };
  if (clientIdFilter) invoiceMatch.client = clientIdFilter;

  const invoices =
    basis === "collected"
      ? await Invoice.find({ ...invoiceMatch, status: "paid", paidAt: { $gte: start, $lte: end } })
          .select("client clientSnapshot subtotal paidAt")
          .lean<LeanInvoice[]>()
      : await Invoice.find({ ...invoiceMatch, status: { $in: ["sent", "paid"] }, issueDate: { $gte: start, $lte: end } })
          .select("client clientSnapshot subtotal issueDate")
          .lean<LeanInvoice[]>();

  // Labour cost is tied to when the work happened, not when (or whether)
  // it's been invoiced — a cost is incurred the moment it's worked.
  const jobMatch: Record<string, unknown> = {
    company: companyId,
    isDeleted: false,
    isTemplate: false,
    status: { $ne: "draft" },
    date: { $gte: start, $lte: end },
  };
  if (clientIdFilter) jobMatch.client = clientIdFilter;

  const jobs = await jobModel.find(jobMatch).select("date client").lean<LeanProfitabilityJob[]>();
  const jobIds = jobs.map(j => j._id);
  const jobById = new Map(jobs.map(j => [j._id.toString(), j]));

  const assignments = jobIds.length
    ? await JobAssignment.find({ job: { $in: jobIds }, isDeleted: false, status: "completed" })
        .select("job approvedMinutes payRate")
        .lean<{ job: string; approvedMinutes?: number | null; payRate?: number }[]>()
    : [];

  const clientIds = new Set<string>([
    ...invoices.filter(i => i.client).map(i => i.client!.toString()),
    ...jobs.filter(j => j.client).map(j => j.client!.toString()),
  ]);
  const clientDocs = clientIds.size
    ? await Client.find({ _id: { $in: [...clientIds] } }).select("name").lean()
    : [];
  const clientNameById = new Map(clientDocs.map(c => [c._id.toString(), c.name]));

  const byClient = new Map<string, { clientName: string; revenue: number; labourCost: number }>();
  const getEntry = (id: string, name: string) => {
    const existing = byClient.get(id);
    if (existing) return existing;
    const fresh = { clientName: name, revenue: 0, labourCost: 0 };
    byClient.set(id, fresh);
    return fresh;
  };

  for (const inv of invoices) {
    if (!inv.client) continue;
    const id = inv.client.toString();
    const entry = getEntry(id, inv.clientSnapshot?.name ?? clientNameById.get(id) ?? "Unknown client");
    entry.revenue += inv.subtotal ?? 0;
  }

  for (const a of assignments) {
    const job = jobById.get(a.job.toString());
    if (!job?.client) continue;
    const id = job.client.toString();
    const entry = getEntry(id, clientNameById.get(id) ?? "Unknown client");
    entry.labourCost += ((a.approvedMinutes ?? 0) / 60) * (a.payRate ?? 0);
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const byClientRows = [...byClient.entries()]
    .map(([clientId, v]) => {
      const profit = v.revenue - v.labourCost;
      return {
        clientId,
        clientName: v.clientName,
        revenue: round2(v.revenue),
        labourCost: round2(v.labourCost),
        profit: round2(profit),
        marginPercent: v.revenue > 0 ? round2((profit / v.revenue) * 100) : 0,
      };
    })
    .sort((a, b) => b.revenue - a.revenue);

  const totalRevenue = byClientRows.reduce((s, r) => s + r.revenue, 0);
  const totalLabourCost = byClientRows.reduce((s, r) => s + r.labourCost, 0);
  const totalProfit = totalRevenue - totalLabourCost;

  // ── Daily trend across the selected range ───────────────────────────────
  const dayCount = Math.max(0, dayjs(end).diff(dayjs(start), "day") + 1);
  const days = Array.from({ length: dayCount }, (_, i) => dayjs(start).add(i, "day"));
  const trendRevenue = new Array(days.length).fill(0);
  const trendLabourCost = new Array(days.length).fill(0);
  const dayIndexFor = (d: Date) => days.findIndex(day => day.isSame(dayjs(d), "day"));

  for (const inv of invoices) {
    const dateField = basis === "collected" ? inv.paidAt : inv.issueDate;
    if (!dateField) continue;
    const idx = dayIndexFor(dateField);
    if (idx >= 0) trendRevenue[idx] += inv.subtotal ?? 0;
  }
  for (const a of assignments) {
    const job = jobById.get(a.job.toString());
    if (!job) continue;
    const idx = dayIndexFor(job.date);
    if (idx < 0) continue;
    trendLabourCost[idx] += ((a.approvedMinutes ?? 0) / 60) * (a.payRate ?? 0);
  }

  const trend = days.map((d, i) => ({
    label: d.format("D MMM"),
    revenue: round2(trendRevenue[i]),
    profit: round2(trendRevenue[i] - trendLabourCost[i]),
  }));

  res.status(StatusCodes.OK).json({
    success: true,
    basis,
    summary: {
      revenue: round2(totalRevenue),
      labourCost: round2(totalLabourCost),
      grossProfit: round2(totalProfit),
      marginPercent: totalRevenue > 0 ? round2((totalProfit / totalRevenue) * 100) : 0,
    },
    trend,
    byClient: byClientRows,
  });
};
