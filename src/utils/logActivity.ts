// utils/logActivity.ts
import mongoose from "mongoose";
import ActivityLog, { type ActivityType } from "../models/ActivityLog.js";
import jobModel from "../models/jobModel.js";

type Id = mongoose.Types.ObjectId | string;

export interface LogActivityParams {
  job: Id;
  type: ActivityType;
  /** Who did it. Omit for system-generated events (cron, auto-completion). */
  actor?: Id | null;
  assignment?: Id;
  /** The single worker a per-assignment event concerns. */
  worker?: Id;
  /** Batch events only (workers_assigned). */
  workers?: Id[];
  /** The date the work happens — denormalised so activity can be filtered by shift date. */
  jobDate?: Date;
  /** Structured before/after for *_updated events. */
  changes?: { field: string; from: any; to: any }[];
  metadata?: Record<string, any>;
}

export async function logActivity(params: LogActivityParams): Promise<void> {
  try {
    const { actor, jobDate, ...rest } = params;

    // Look the date up only when the caller didn't supply it — saves a query
    // on the hot paths that already have the job loaded.
    let resolvedJobDate = jobDate;
    if (!resolvedJobDate) {
      const job = await jobModel.findById(params.job).select("date").lean();
      resolvedJobDate = job?.date;
    }

    await ActivityLog.create({
      ...rest,
      actor: actor ?? undefined,
      isSystem: !actor,
      jobDate: resolvedJobDate,
    });
  } catch (err) {
    // Logging is never worth failing a user action over — a shift that
    // completed shouldn't roll back because the audit write hiccupped.
    console.error("logActivity failed:", err);
  }
}

/** Bulk variant — one insertMany instead of N creates. */
export async function logActivityMany(entries: LogActivityParams[]): Promise<void> {
  if (!entries.length) return;
  try {
    const docs = entries.map(({ actor, ...rest }) => ({
      ...rest,
      actor: actor ?? undefined,
      isSystem: !actor,
    }));
    await ActivityLog.insertMany(docs, { ordered: false });
  } catch (err) {
    console.error("logActivityMany failed:", err);
  }
}