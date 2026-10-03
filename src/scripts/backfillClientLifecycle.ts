// One-off migration: every Client document that predates the lifecycle
// field (clientModel.ts) is a real, already-working client relationship —
// not a lead. Mongoose's schema default ("lead") only applies when a
// document is hydrated from the DB with the field missing; it never writes
// that default back to Mongo. Until this runs, every pre-existing client
// would read back as lifecycle:"lead" through the API and vanish from the
// Clients page the moment leadController/clientController start filtering
// on lifecycle.
//
// Run with: node dist/scripts/backfillClientLifecycle.js [--dry-run]
// (build first with `npm run build`.)
import * as dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import mongoose from "mongoose";
import Client from "../models/clientModel.js";

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error("MONGO_URI is not set.");

    await mongoose.connect(uri);

    console.log(DRY_RUN ? "DRY RUN — no database changes were made." : "LIVE RUN — this will modify the database.");
    console.log("");

    // $exists: false, not { $eq: null } — a document that genuinely has
    // lifecycle: null (shouldn't happen, but defensively) is left alone
    // rather than silently reclassified.
    const filter = { lifecycle: { $exists: false } };

    const count = await Client.countDocuments(filter);
    console.log(`Found ${count} client(s) with no lifecycle field — these predate the leads feature.`);

    if (!count) {
        console.log("Nothing to migrate.");
        await mongoose.disconnect();
        return;
    }

    if (DRY_RUN) {
        console.log(`Would set lifecycle: "client" on ${count} document(s).`);
        console.log("");
        console.log("DRY RUN — no database changes were made.");
        await mongoose.disconnect();
        return;
    }

    // Raw updateMany, not a per-document .save() loop — these are all
    // already-real clients with nothing else to validate, and the
    // lifecycle pre("validate") hook's "client" branch (convertedAt,
    // clearing lead fields) is a no-op for a document with no lead fields
    // set in the first place. $currentDate stamps convertedAt too, since
    // these clients have been "converted" since before conversion existed.
    const result = await Client.updateMany(filter, {
        $set: { lifecycle: "client" },
        $currentDate: { convertedAt: true },
    });

    console.log(`Updated ${result.modifiedCount} of ${result.matchedCount} matched document(s).`);
    console.log("");
    console.log("Migration complete.");

    await mongoose.disconnect();
}

main().catch(err => {
    console.error("Migration failed:", err);
    process.exit(1);
});
