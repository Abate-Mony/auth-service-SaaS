import mongoose from "mongoose";
import Company from "../models/company.js";
import User from "../models/userModel.js";
import Job from "../models/jobModel.js";
import Invoice from "../models/invoiceModel.js";
import { assessHealth, CompanyHealth } from "../utils/companyHealth.js";

const DAY = 24 * 60 * 60 * 1000;

/** Health for each company id, from a handful of grouped queries (no per-company loop). */
export async function getCompanyHealth(companyIds: string[]): Promise<Map<string, CompanyHealth>> {
  const out = new Map<string, CompanyHealth>();
  if (companyIds.length === 0) return out;

  const objectIds = companyIds.map(id => new mongoose.Types.ObjectId(id));
  const since = new Date(Date.now() - 30 * DAY);

  const [companies, logins, workers, jobsRecent, jobsAny, invoices] = await Promise.all([
    Company.find({ _id: { $in: objectIds } }).select("createdAt subscriptionStatus").lean(),
    User.aggregate([
      { $match: { company: { $in: objectIds }, role: { $in: ["owner", "admin", "manager"] } } },
      { $group: { _id: "$company", last: { $max: "$lastLogin" } } },
    ]),
    User.aggregate([
      { $match: { company: { $in: objectIds }, role: "worker", isActive: { $ne: false } } },
      { $group: { _id: "$company", count: { $sum: 1 } } },
    ]),
    // Job.company is a String (see planLimits.ts)
    Job.aggregate([
      { $match: { company: { $in: companyIds }, isDeleted: { $ne: true }, isTemplate: { $ne: true }, createdAt: { $gte: since } } },
      { $group: { _id: "$company", count: { $sum: 1 } } },
    ]),
    Job.aggregate([
      { $match: { company: { $in: companyIds }, isTemplate: { $ne: true } } },
      { $group: { _id: "$company" } },
    ]),
    Invoice.aggregate([
      { $match: { company: { $in: objectIds } } },
      { $group: { _id: "$company" } },
    ]),
  ]);

  const key = (v: unknown) => String(v);
  const loginBy = new Map(logins.map(l => [key(l._id), l.last as Date | null]));
  const workersBy = new Map(workers.map(w => [key(w._id), w.count as number]));
  const recentBy = new Map(jobsRecent.map(j => [key(j._id), j.count as number]));
  const anyJob = new Set(jobsAny.map(j => key(j._id)));
  const anyInvoice = new Set(invoices.map(i => key(i._id)));

  for (const c of companies) {
    const id = c._id.toString();
    const activeWorkers = workersBy.get(id) ?? 0;
    out.set(
      id,
      assessHealth({
        createdAt: c.createdAt as Date,
        lastManagerLoginAt: loginBy.get(id) ?? null,
        jobsLast30Days: recentBy.get(id) ?? 0,
        activeWorkers,
        subscriptionStatus: (c as any).subscriptionStatus ?? null,
        onboarding: { firstJob: anyJob.has(id), workerInvited: activeWorkers > 0, firstInvoice: anyInvoice.has(id) },
      })
    );
  }
  return out;
}
