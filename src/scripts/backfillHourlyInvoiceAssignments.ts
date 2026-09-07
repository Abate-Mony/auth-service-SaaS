// One-off data fix: the manual single-job invoice endpoint (POST /invoices)
// used to mark ONLY Job.billingStatus/Job.invoice as invoiced, no matter the
// job's chargeType. That's correct for fixed-price jobs (billing state lives
// on the Job), but wrong for hourly jobs — those track billing per
// JobAssignment instead (see the model comment on Job.billingStatus for why).
// Any hourly job invoiced through that manual form before the fix ended up
// with an invoice that never touched its JobAssignments: the eligible-work
// picker had no record it was billed (a double-invoicing risk) and nothing
// could look up "which invoice covers this job" from the assignment side.
//
// This finds exactly those invoices (jobs referenced but no assignments
// recorded, and the referenced job is hourly) and backfills:
//   - invoice.assignments = that job's completed JobAssignment ids
//   - each of those JobAssignment's billingStatus/invoice
//
// Run with: node dist/scripts/backfillHourlyInvoiceAssignments.js [--dry-run]
// (build first with `npm run build`)
import * as dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import mongoose from "mongoose";
import Invoice from "../models/invoiceModel.js";
import Job from "../models/jobModel.js";
import JobAssignment from "../models/JobAssignment.js";

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error("MONGO_URI is not set.");

    await mongoose.connect(uri);
    console.log(DRY_RUN ? "DRY RUN — no database changes were made." : "LIVE RUN — this will modify the database.");

    const candidates = await Invoice.find({
        isDeleted: false,
        status: { $ne: "cancelled" },
        jobs: { $exists: true, $not: { $size: 0 } },
        $or: [{ assignments: { $exists: false } }, { assignments: { $size: 0 } }],
    });

    let fixedInvoices = 0;
    let fixedAssignments = 0;

    for (const invoice of candidates) {
        const jobs = await Job.find({ _id: { $in: invoice.jobs }, chargeType: "hourly" }).select("_id title chargeType");
        if (!jobs.length) continue;

        const jobIds = jobs.map(j => j._id);
        const assignments = await JobAssignment.find({
            job: { $in: jobIds },
            isDeleted: false,
            status: "completed",
        }).select("_id job fullname billingStatus invoice");

        const toBackfill = assignments.filter(a => a.billingStatus !== "invoiced" || !a.invoice);
        if (!toBackfill.length) continue;

        console.log(
            `Invoice ${invoice.invoiceNumber} (${invoice._id}) — jobs: ${jobs.map(j => j.title).join(", ")} — ` +
                `backfilling ${toBackfill.length} assignment(s): ${toBackfill.map(a => a.fullname).join(", ")}`
        );

        fixedInvoices += 1;
        fixedAssignments += toBackfill.length;

        if (!DRY_RUN) {
            const assignmentIds = toBackfill.map(a => a._id);
            await JobAssignment.updateMany(
                { _id: { $in: assignmentIds } },
                { $set: { billingStatus: "invoiced", invoice: invoice._id } }
            );
            invoice.assignments = Array.from(new Set([...(invoice.assignments ?? []), ...assignmentIds])) as any;
            await invoice.save();
        }
    }

    console.log(`\nDone. ${fixedInvoices} invoice(s), ${fixedAssignments} assignment(s) ${DRY_RUN ? "would be" : "were"} backfilled.`);
    await mongoose.disconnect();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
