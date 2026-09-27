// One-off data repair: some existing RecurringJob (schedule) documents are
// missing `company`, even though the schema has always declared it
// `required: true` — Mongoose only enforces that on writes it performs
// itself, so pre-existing documents from before this field existed (or
// written outside the normal create path, e.g. a direct DB edit) can still
// be missing it. That's what caused admin's "Recurring Jobs" list
// (company-scoped) to silently exclude a schedule that workers could still
// see (their view resolves schedules by id from their own assignments, no
// company filter at all).
//
// Run with: node dist/scripts/backfillRecurringJobCompany.js [--dry-run]
// (build first with `npm run build`.)
//
// Derives the correct company from the schedule's own templateJob (a Job
// document, whose `company` field has always been required) rather than
// guessing — every occurrence a schedule generates shares its
// templateJob's company by construction (see createRecurringJob in
// jobController.ts), so this is the one place with an authoritative answer,
// not an assumption. Idempotent: a schedule that already has `company` is
// left untouched, so re-running after a partial failure is safe.
import * as dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import mongoose from "mongoose";
import Job from "../models/jobModel.js";
import recurringJobModel from "../models/recurringJobModel.js";

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error("MONGO_URI is not set.");

    await mongoose.connect(uri);

    console.log(DRY_RUN ? "DRY RUN — no database changes were made." : "LIVE RUN — this will modify the database.");
    console.log("");

    const orphaned = await recurringJobModel
        .find({ $or: [{ company: null }, { company: { $exists: false } }] })
        .select("_id templateJob active")
        .lean();

    console.log(`Found ${orphaned.length} recurring job schedule(s) with no company.`);

    let fixed = 0;
    let missingTemplateJob = 0;
    let templateJobMissingCompany = 0;

    for (const schedule of orphaned) {
        const templateJob = await Job.findById(schedule.templateJob).select("company title").lean();

        if (!templateJob) {
            console.warn(`Schedule ${schedule._id.toString()}: templateJob ${schedule.templateJob?.toString()} no longer exists — skipping, needs manual review.`);
            missingTemplateJob++;
            continue;
        }

        if (!templateJob.company) {
            console.warn(`Schedule ${schedule._id.toString()} ("${templateJob.title}"): templateJob itself has no company — skipping, needs manual review.`);
            templateJobMissingCompany++;
            continue;
        }

        console.log(`${DRY_RUN ? "Would set" : "Setting"} company=${templateJob.company} on schedule ${schedule._id.toString()} ("${templateJob.title}").`);
        fixed++;

        if (!DRY_RUN) {
            await recurringJobModel.updateOne({ _id: schedule._id }, { $set: { company: templateJob.company } });
        }
    }

    console.log("");
    console.log(DRY_RUN ? "Backfill dry run complete" : "Backfill complete");
    console.log("");
    console.log(`Fixed: ${fixed}`);
    console.log(`Missing templateJob: ${missingTemplateJob}`);
    console.log(`templateJob itself missing company: ${templateJobMissingCompany}`);

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
