// One-off data repair: self-claimed open shifts (claimOpenShift) used to be
// created without copying the job's payRate onto the assignment, unlike
// manager-made assignments (createJob/updateJob in jobController.ts), so
// they sat at the schema default of 0. Every pay figure reads the rate off
// the assignment — worker earnings (getWorkerDashboardStats, getMyEarnings)
// and labour cost (reportController) — so those shifts counted as £0.
// claimOpenShift / takeShiftGiveaway now set it at creation; this fixes the
// records created before that.
//
// Run with: node dist/scripts/backfillClaimedAssignmentPayRates.js [--dry-run]
// (build first with `npm run build`.)
//
// Scope: assignments the worker created for themselves (createdBy ===
// worker — what identifies a self-claim, see getMyClaims) with a payRate of
// 0/missing, on a job whose own payRate is above 0. A job at £0 is left
// alone — there's nothing better to copy. Manager-made assignments are never
// touched, even at 0, since a manager may have set that deliberately.
// Idempotent: a fixed assignment no longer matches, so re-running is safe.
import * as dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import mongoose from "mongoose";
import JobAssignment from "../models/JobAssignment.js";
import "../models/jobModel.js";

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error("MONGO_URI is not set.");

    await mongoose.connect(uri);

    console.log(DRY_RUN ? "DRY RUN — no database changes were made." : "LIVE RUN — this will modify the database.");
    console.log("");

    const candidates = await JobAssignment.aggregate([
        {
            $match: {
                isDeleted: false,
                $or: [{ payRate: 0 }, { payRate: null }, { payRate: { $exists: false } }],
                $expr: { $eq: ["$createdBy", "$worker"] },
            },
        },
        {
            $lookup: {
                from: "jobs",
                let: { jobId: "$job" },
                pipeline: [
                    { $match: { $expr: { $eq: ["$_id", "$$jobId"] } } },
                    { $project: { title: 1, date: 1, payRate: 1 } },
                ],
                as: "job",
            },
        },
        { $unwind: { path: "$job", preserveNullAndEmptyArrays: true } },
        { $project: { fullname: 1, status: 1, job: 1 } },
    ]);

    console.log(`Found ${candidates.length} self-claimed assignment(s) with no pay rate.`);
    console.log("");

    const updates: { id: mongoose.Types.ObjectId; payRate: number }[] = [];
    let jobMissing = 0;
    let jobAtZero = 0;

    for (const a of candidates) {
        if (!a.job) {
            console.warn(`Assignment ${a._id}: job no longer exists — skipping.`);
            jobMissing++;
            continue;
        }
        if (!a.job.payRate || a.job.payRate <= 0) {
            jobAtZero++;
            continue;
        }

        const date = a.job.date ? new Date(a.job.date).toISOString().slice(0, 10) : "no date";
        console.log(
            `${DRY_RUN ? "Would set" : "Setting"} payRate=${a.job.payRate} on assignment ${a._id} ` +
            `(${a.fullname}, "${a.job.title}" ${date}, ${a.status}).`
        );
        updates.push({ id: a._id, payRate: a.job.payRate });
    }

    if (!DRY_RUN && updates.length) {
        // Re-checks payRate in the filter so a rate set since the read above
        // (e.g. by a manager) is never overwritten.
        const result = await JobAssignment.bulkWrite(
            updates.map(u => ({
                updateOne: {
                    filter: { _id: u.id, $or: [{ payRate: 0 }, { payRate: null }, { payRate: { $exists: false } }] },
                    update: { $set: { payRate: u.payRate } },
                },
            })),
            { ordered: false }
        );
        console.log("");
        console.log(`Database reported ${result.modifiedCount} assignment(s) modified.`);
    }

    console.log("");
    console.log(DRY_RUN ? "Backfill dry run complete" : "Backfill complete");
    console.log("");
    console.log(`${DRY_RUN ? "Would fix" : "Fixed"}: ${updates.length}`);
    console.log(`Skipped — job pay rate is also 0: ${jobAtZero}`);
    console.log(`Skipped — job no longer exists: ${jobMissing}`);

    if (DRY_RUN) {
        console.log("");
        console.log("DRY RUN — no database changes were made.");
    }

    await mongoose.disconnect();
}

main().catch(err => {
    console.error("Backfill failed:", err);
    process.exit(1);
});
