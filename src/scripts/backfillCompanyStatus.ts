// One-off migration: every Company document that predates the `status`
// field (company.ts) has no lifecycle field stored at all. Mongoose's
// schema default ("active") only applies when a document is hydrated
// through the model — it never writes that default back to Mongo. Found
// via a real bug: resolvePublicCompany (publicQuoteIntakeController.ts)
// used to filter `{ status: "active" }` directly in the query, which
// silently excluded every company missing the field — a real company's
// public quote link 404ing with no explanation. That query no longer
// filters on status directly (it checks the hydrated value in code
// instead, like companyStatusMiddleware.ts always has), but these
// documents are still missing the field in storage, so this backfills it
// the same way backfillClientLifecycle.ts did for Client.lifecycle.
//
// Run with: node dist/scripts/backfillCompanyStatus.js [--dry-run]
import * as dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import mongoose from "mongoose";
import Company from "../models/company.js";

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error("MONGO_URI is not set.");

    await mongoose.connect(uri);

    console.log(DRY_RUN ? "DRY RUN — no database changes were made." : "LIVE RUN — this will modify the database.");
    console.log("");

    const filter = { status: { $exists: false } };

    const count = await Company.countDocuments(filter);
    console.log(`Found ${count} company(ies) with no status field — these predate the status field.`);

    if (!count) {
        console.log("Nothing to migrate.");
        await mongoose.disconnect();
        return;
    }

    if (DRY_RUN) {
        console.log(`Would set status: "active" on ${count} document(s).`);
        console.log("");
        console.log("DRY RUN — no database changes were made.");
        await mongoose.disconnect();
        return;
    }

    const result = await Company.updateMany(filter, { $set: { status: "active" } });

    console.log(`Updated ${result.modifiedCount} of ${result.matchedCount} matched document(s).`);
    console.log("");
    console.log("Migration complete.");

    await mongoose.disconnect();
}

main().catch(err => {
    console.error("Migration failed:", err);
    process.exit(1);
});
