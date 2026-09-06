// services/invoice/eligibility.ts
//
// Single source of truth for "is this work ready to invoice" — every place
// that needs that answer (the eligible-work endpoint, draft creation) goes
// through here, so the rule can't drift between the picker the manager sees
// and the numbers the draft actually gets created with.
//
// Confirmed billing model: hourly charge is per WORKER-hour. A fixed-price
// job is one billable unit (the Job); an hourly job is billed per completed,
// approved-time JobAssignment — two workers on one shift are two separate
// line items, not one. That split is also why billing state lives on Job
// for fixed jobs but on JobAssignment for hourly ones (see the model
// comments on Job.billingStatus / JobAssignment.billingStatus).
import mongoose from "mongoose";
import Job from "../../models/jobModel.js";
import JobAssignment from "../../models/JobAssignment.js";
import Client from "../../models/clientModel.js";
import Invoice from "../../models/invoiceModel.js";
import { BadRequestError, NotFoundError } from "../../errors/customErrors.js";
import { calculateFixedAmount, calculateHourlyAmount } from "./calculations.js";

export interface EligibleWorkItem {
  jobId: string;
  assignmentId?: string;
  title: string;
  date: Date;
  startTime: string;
  endTime: string;
  chargeType: "hourly" | "fixed";
  workerName?: string;
  approvedMinutes?: number;
  quantity: number;
  rate: number;
  amount: number;
}

interface LeanJobForBilling {
  _id: mongoose.Types.ObjectId;
  title: string;
  date: Date;
  startTime: string;
  endTime: string;
  status: string;
  chargeType: "hourly" | "fixed";
  chargeRate: number;
  chargeAmount: number;
  billingStatus: string;
}

interface LeanAssignmentForBilling {
  _id: mongoose.Types.ObjectId;
  job: mongoose.Types.ObjectId;
  fullname: string;
  status: string;
  approvedMinutes?: number | null;
  checkedInAt?: Date | null;
  checkedOutAt?: Date | null;
  breaks?: { startedAt?: Date | null; endedAt?: Date | null }[];
  billingStatus: string;
}

const workedMinutesOf = (a: LeanAssignmentForBilling): number => {
  if (!a.checkedInAt || !a.checkedOutAt) return 0;
  const gross = Math.round((a.checkedOutAt.getTime() - a.checkedInAt.getTime()) / 60_000);
  const breakMins = (a.breaks ?? []).reduce((sum, b) => {
    if (!b.startedAt || !b.endedAt) return sum;
    return sum + Math.round((b.endedAt.getTime() - b.startedAt.getTime()) / 60_000);
  }, 0);
  return Math.max(0, gross - breakMins);
};

// approvedMinutes is set automatically at clock-out and already excludes
// any overtime still awaiting manager review (capped at the scheduled
// amount until then) — safe to bill directly, never falls back to raw
// actual time for a record that needs review.
const billableMinutesOf = (a: LeanAssignmentForBilling): number =>
  a.approvedMinutes != null ? a.approvedMinutes : workedMinutesOf(a);

interface RawEligibleSources {
  client: InstanceType<typeof Client>;
  fixedJobs: LeanJobForBilling[];
  hourlyAssignments: { assignment: LeanAssignmentForBilling; job: LeanJobForBilling }[];
}

/**
 * Everything in this company+client+period window that is genuinely ready
 * to invoice — completed, not deleted/cancelled, not already on a live
 * invoice. This is the one place that decides "ready"; nothing else should
 * re-implement this filter.
 */
const queryEligibleSources = async (
  companyId: string,
  clientId: string,
  start: Date,
  end: Date
): Promise<RawEligibleSources> => {
  if (!mongoose.Types.ObjectId.isValid(clientId)) {
    throw new BadRequestError("A valid client is required.");
  }

  const client = await Client.findOne({ _id: clientId, company: companyId, isDeleted: false });
  if (!client) throw new NotFoundError("Client not found.");

  // Job.company is schema-typed String (a pre-existing quirk elsewhere in
  // this codebase), unlike Client/Invoice's ObjectId.
  const jobs = await Job.find({
    company: companyId.toString(),
    client: clientId,
    isDeleted: false,
    isTemplate: false,
    status: { $ne: "draft" },
    date: { $gte: start, $lte: end },
  })
    .select("title date startTime endTime status chargeType chargeRate chargeAmount billingStatus")
    .lean<LeanJobForBilling[]>();

  const jobIds = jobs.map(j => j._id);
  const jobById = new Map(jobs.map(j => [j._id.toString(), j]));

  const assignments = jobIds.length
    ? await JobAssignment.find({ job: { $in: jobIds }, isDeleted: false, status: "completed" })
        .select("job fullname status approvedMinutes checkedInAt checkedOutAt breaks billingStatus")
        .lean<LeanAssignmentForBilling[]>()
    : [];
  const assignmentIds = assignments.map(a => a._id);

  // Belt-and-suspenders against the pre-existing manual invoice flow, which
  // predates billingStatus and never set it: also exclude anything already
  // sitting on a live (non-cancelled) invoice, not just billingStatus.
  const alreadyInvoiced = jobIds.length
    ? await Invoice.find({
        company: companyId,
        status: { $ne: "cancelled" },
        isDeleted: false,
        $or: [{ jobs: { $in: jobIds } }, { assignments: { $in: assignmentIds } }],
      })
        .select("jobs assignments")
        .lean()
    : [];
  const invoicedJobIds = new Set(alreadyInvoiced.flatMap(inv => (inv.jobs ?? []).map((j: any) => j.toString())));
  const invoicedAssignmentIds = new Set(
    alreadyInvoiced.flatMap(inv => (inv.assignments ?? []).map((a: any) => a.toString()))
  );

  const fixedJobs = jobs.filter(
    j =>
      j.chargeType === "fixed" &&
      j.status === "completed" &&
      j.billingStatus !== "invoiced" &&
      !invoicedJobIds.has(j._id.toString())
  );

  const hourlyAssignments = assignments
    .filter(a => a.billingStatus !== "invoiced" && !invoicedAssignmentIds.has(a._id.toString()))
    .map(a => ({ assignment: a, job: jobById.get(a.job.toString()) }))
    .filter((x): x is { assignment: LeanAssignmentForBilling; job: LeanJobForBilling } => !!x.job && x.job.chargeType === "hourly");

  return { client, fixedJobs, hourlyAssignments };
};

const toItem = (source: RawEligibleSources): EligibleWorkItem[] => {
  const items: EligibleWorkItem[] = [];

  for (const job of source.fixedJobs) {
    items.push({
      jobId: job._id.toString(),
      title: job.title,
      date: job.date,
      startTime: job.startTime,
      endTime: job.endTime,
      chargeType: "fixed",
      quantity: 1,
      rate: job.chargeAmount,
      amount: calculateFixedAmount(job.chargeAmount),
    });
  }

  for (const { assignment, job } of source.hourlyAssignments) {
    const minutes = billableMinutesOf(assignment);
    items.push({
      jobId: job._id.toString(),
      assignmentId: assignment._id.toString(),
      title: job.title,
      date: job.date,
      startTime: job.startTime,
      endTime: job.endTime,
      chargeType: "hourly",
      workerName: assignment.fullname,
      approvedMinutes: minutes,
      quantity: Number((minutes / 60).toFixed(2)),
      rate: job.chargeRate,
      amount: calculateHourlyAmount(minutes, job.chargeRate),
    });
  }

  // Oldest first — reads like a statement of the period.
  return items.sort((a, b) => a.date.getTime() - b.date.getTime());
};

export const getEligibleWork = async (companyId: string, clientId: string, start: Date, end: Date) => {
  const source = await queryEligibleSources(companyId, clientId, start, end);
  const items = toItem(source);

  const jobIds = new Set(items.map(i => i.jobId));
  const assignmentIds = items.filter(i => i.assignmentId).map(i => i.assignmentId as string);
  const totalMinutes = items.reduce((sum, i) => sum + (i.approvedMinutes ?? 0), 0);
  const subtotal = items.reduce((sum, i) => sum + i.amount, 0);

  return {
    client: {
      _id: source.client._id.toString(),
      name: source.client.name,
      defaultChargeType: source.client.defaultChargeType,
      defaultChargeRate: source.client.defaultChargeRate,
      paymentTermsDays: source.client.paymentTermsDays,
      billingEmail: source.client.billingEmail,
    },
    period: { start, end },
    items,
    summary: {
      jobs: jobIds.size,
      assignments: assignmentIds.length,
      totalMinutes,
      subtotal: Math.round(subtotal * 100) / 100,
    },
  };
};

/**
 * Re-validates a manager's selection against the same eligibility rule and
 * recalculates every amount server-side — the frontend's numbers are never
 * trusted for what actually gets billed. Throws if anything selected is no
 * longer eligible (already invoiced by a concurrent request, deleted, etc.)
 * rather than silently dropping it, so a manager isn't left wondering why
 * a total came back different from what they selected.
 */
export const resolveSelectedWork = async (
  companyId: string,
  clientId: string,
  start: Date,
  end: Date,
  selection: { jobIds?: string[]; assignmentIds?: string[] }
) => {
  const source = await queryEligibleSources(companyId, clientId, start, end);

  const wantedJobIds = new Set(selection.jobIds ?? []);
  const wantedAssignmentIds = new Set(selection.assignmentIds ?? []);
  if (wantedJobIds.size === 0 && wantedAssignmentIds.size === 0) {
    throw new BadRequestError("Select at least one item to invoice.");
  }

  const selectedFixedJobs = source.fixedJobs.filter(j => wantedJobIds.has(j._id.toString()));
  const selectedHourly = source.hourlyAssignments.filter(({ assignment }) =>
    wantedAssignmentIds.has(assignment._id.toString())
  );

  const foundJobIds = new Set(selectedFixedJobs.map(j => j._id.toString()));
  const foundAssignmentIds = new Set(selectedHourly.map(({ assignment }) => assignment._id.toString()));
  const missingJobIds = [...wantedJobIds].filter(id => !foundJobIds.has(id));
  const missingAssignmentIds = [...wantedAssignmentIds].filter(id => !foundAssignmentIds.has(id));
  if (missingJobIds.length || missingAssignmentIds.length) {
    throw new BadRequestError(
      "Some of the selected work is no longer available to invoice — it may have just been invoiced elsewhere. Refresh and try again."
    );
  }

  const items = toItem({ client: source.client, fixedJobs: selectedFixedJobs, hourlyAssignments: selectedHourly });

  return {
    client: source.client,
    items,
    jobIds: [...foundJobIds],
    assignmentIds: [...foundAssignmentIds],
    subtotal: Math.round(items.reduce((sum, i) => sum + i.amount, 0) * 100) / 100,
  };
};
