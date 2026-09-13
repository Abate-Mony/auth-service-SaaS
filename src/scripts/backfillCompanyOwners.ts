// One-off migration: promotes each existing Company's founder to the new
// "owner" role.
//
// Run with: node dist/scripts/backfillCompanyOwners.js [--dry-run]
// (build first with `npm run build`.)
//
// Every Company has always had a required `owner` field (set at signup in
// authControler.ts's register()), so there's nothing to guess here — this
// just reads that field and makes the corresponding User's `role` match it.
// Idempotent: a user already on "owner" is left alone, so re-running after
// a partial failure is safe.
import * as dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import mongoose from "mongoose";
import Company from "../models/company.js";
import User from "../models/userModel.js";

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error("MONGO_URI is not set.");

    await mongoose.connect(uri);

    console.log(DRY_RUN ? "DRY RUN — no database changes were made." : "LIVE RUN — this will modify the database.");
    console.log("");

    const companies = await Company.find({}).select("_id name owner").lean();
    console.log(`Found ${companies.length} compan${companies.length === 1 ? "y" : "ies"}.`);

    let promoted = 0;
    let alreadyOwner = 0;
    let missingOwnerUser = 0;
    let unexpectedRole = 0;

    for (const company of companies) {
        if (!company.owner) {
            console.warn(`Company ${company._id.toString()} ("${company.name}") has no owner set — skipping, needs manual review.`);
            missingOwnerUser++;
            continue;
        }

        const owner = await User.findById(company.owner).select("_id role email fullname");
        if (!owner) {
            console.warn(`Company ${company._id.toString()} ("${company.name}")'s owner user ${company.owner.toString()} no longer exists — skipping.`);
            missingOwnerUser++;
            continue;
        }

        if (owner.role === "owner") {
            alreadyOwner++;
            continue;
        }

        if (owner.role !== "admin") {
            // Founders were always created with role "admin" pre-migration,
            // so anything else here (manager/worker) is unexpected — flag it
            // for a human rather than silently overwriting their role.
            console.warn(
                `Company ${company._id.toString()} ("${company.name}")'s owner ${owner.email} has unexpected role "${owner.role}" — skipping, needs manual review.`
            );
            unexpectedRole++;
            continue;
        }

        console.log(`${DRY_RUN ? "Would promote" : "Promoting"} ${owner.email} (${owner.fullname}) to owner of "${company.name}".`);
        promoted++;

        if (!DRY_RUN) {
            await User.updateOne({ _id: owner._id }, { $set: { role: "owner" } });
        }
    }

    console.log("");
    console.log(DRY_RUN ? "Backfill dry run complete" : "Backfill complete");
    console.log("");
    console.log(`Promoted to owner: ${promoted}`);
    console.log(`Already owner: ${alreadyOwner}`);
    console.log(`Missing owner user: ${missingOwnerUser}`);
    console.log(`Unexpected existing role: ${unexpectedRole}`);

    if (DRY_RUN) {
        console.log("");
        console.log("DRY RUN — no database changes were made.");
    }

    await mongoose.disconnect();
}

main().catch(err => {
    console.error("Migration failed:", err);
    process.exit(1);
});
