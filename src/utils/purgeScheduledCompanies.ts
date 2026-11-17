import mongoose from "mongoose";
import Company from "../models/company.js";
import User from "../models/userModel.js";
import Job from "../models/jobModel.js";
import ActivityLog from "../models/ActivityLog.js";
import PlatformAuditLog from "../models/PlatformAuditLog.js";

// Permanently deletes companies whose scheduled deletion date has passed
// (Company.deletionScheduledAt, set from the platform with a 30-day grace).
//
// Destructive and irreversible, so it only deletes when the server has
// COMPANY_PURGE_ENABLED=true. Without it the job just logs what it would
// delete — run it from Platform → System to see the dry run first.
//
// Deletes every document in every model that has a `company` path matching
// the company (jobs, assignments, clients, sites, quotes, invoices, users,
// notifications…), plus job activity logs, then the company itself. The
// platform audit log is kept on purpose. Uploaded files (Cloudinary) are
// not removed by this job.

// Models with a `company` path that must NOT be purged with the tenant.
const KEEP_MODELS = new Set(["PlatformAuditLog", "Company"]);

let running = false;

export async function purgeScheduledCompanies() {
  if (running) return;
  running = true;
  try {
    const enabled = process.env.COMPANY_PURGE_ENABLED === "true";
    const due = await Company.find({ deletionScheduledAt: { $ne: null, $lte: new Date() } }).select("name deletionScheduledAt");

    for (const company of due) {
      const id = company._id;
      const idStr = id.toString();
      const match = { company: { $in: [id, idStr] } };

      const jobIds = (await Job.find({ company: idStr }).select("_id").lean()).map(j => j._id);
      const plan: { model: string; count: number }[] = [];
      for (const name of mongoose.modelNames()) {
        if (KEEP_MODELS.has(name)) continue;
        const model = mongoose.model(name);
        if (!model.schema.path("company")) continue;
        plan.push({ model: name, count: await model.countDocuments(match as any) });
      }
      const activityCount = jobIds.length ? await ActivityLog.countDocuments({ job: { $in: jobIds } }) : 0;

      if (!enabled) {
        console.log(
          `[purgeScheduledCompanies] DRY RUN (COMPANY_PURGE_ENABLED is not "true") — would delete company ${idStr} "${company.name}":`,
          [...plan.filter(p => p.count), { model: "ActivityLog", count: activityCount }]
        );
        continue;
      }

      try {
        if (jobIds.length) await ActivityLog.deleteMany({ job: { $in: jobIds } });
        for (const p of plan) {
          if (p.count && p.model !== "User") await mongoose.model(p.model).deleteMany(match as any);
        }
        await User.deleteMany({ company: id });
        await Company.deleteOne({ _id: id });

        await PlatformAuditLog.create({
          actor: id, // no human actor: the scheduled purge
          actorEmail: "system@onclockly",
          actorPlatformRole: "system",
          action: "company.purged",
          targetType: "Company",
          targetId: idStr,
          company: id,
          reason: "Scheduled deletion date passed",
          before: { name: company.name, deletionScheduledAt: company.deletionScheduledAt },
          after: null,
          result: "success",
          metadata: { deleted: [...plan, { model: "ActivityLog", count: activityCount }] },
        });
        console.log(`[purgeScheduledCompanies] purged company ${idStr}`);
      } catch (err) {
        console.error(`[purgeScheduledCompanies] failed to purge company ${idStr}:`, err);
      }
    }
  } finally {
    running = false;
  }
}
