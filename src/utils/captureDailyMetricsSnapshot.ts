// Scheduled daily at 23:55 UTC (see cronRegistry.ts) so that day's counts
// are as complete as possible before being frozen. Upserts by `date` so a
// manual re-run (or the job somehow firing twice the same day) overwrites
// that day's row instead of creating a duplicate.
//
// No backfill is possible — nothing recorded these numbers before this job
// existed, so the very first run is the first data point a trend chart can
// show. See PlatformMetricsSnapshot.ts's own comment and
// PlatformOverview.tsx, which says this plainly rather than implying a
// longer history than really exists.
import Company from "../models/company.js";
import User from "../models/userModel.js";
import Job from "../models/jobModel.js";
import PlatformMetricsSnapshot from "../models/PlatformMetricsSnapshot.js";

export async function captureDailyMetricsSnapshot(): Promise<void> {
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10);
  const startOfDay = new Date(`${dateKey}T00:00:00.000Z`);

  const [companiesTotal, companiesActive, companiesNew, workersActive, jobsCreated] = await Promise.all([
    Company.countDocuments({}),
    Company.countDocuments({ status: "active" }),
    Company.countDocuments({ createdAt: { $gte: startOfDay } }),
    User.countDocuments({ role: "worker", isActive: true }),
    // Job.company is schema-typed String (see planLimits.ts's own note) —
    // irrelevant here since this counts across every company.
    Job.countDocuments({ isDeleted: false, isTemplate: false, createdAt: { $gte: startOfDay } }),
  ]);

  await PlatformMetricsSnapshot.updateOne(
    { date: dateKey },
    { $set: { companiesTotal, companiesActive, companiesNew, workersActive, jobsCreated } },
    { upsert: true }
  );
}
