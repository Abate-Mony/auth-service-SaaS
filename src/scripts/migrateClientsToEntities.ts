// One-off migration: converts legacy Job.client (free-text string) into a
// real Client document + ObjectId reference.
//
// Run with: node dist/scripts/migrateClientsToEntities.js [--dry-run]
// (build first with `npm run build` — this compiles alongside the rest of
// src/ since it lives under src/scripts, not a top-level scripts/ directory;
// see the deployment-order note below for why.)
//
// ── Why this reads the "jobs" collection with the raw driver ────────────
// The whole point of this script is to run BEFORE the Job.client schema
// field is switched from String to ObjectId. But this codebase's src/ is
// one shared TypeScript program — by the time this file exists at all,
// jobModel.ts already declares `client` as an ObjectId ref. If this script
// went through the Mongoose Job model, every read would run the legacy
// string values through the ObjectId caster and fail or silently drop them.
// Using the raw driver (mongoose.connection.db.collection("jobs")) instead
// means this script's own correctness never depends on which schema shape
// is currently deployed — it works whether Job.client is still String or
// has already become ObjectId (already-migrated jobs simply have a BSON
// ObjectId value, which $type: "string" naturally excludes, so a second
// run is a safe no-op for anything already done).
import * as dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import mongoose from "mongoose";
import ClientModel from "../models/clientModel.js";

const DRY_RUN = process.argv.includes("--dry-run");

interface LegacyJobRow {
    _id: mongoose.Types.ObjectId;
    client?: string;
    company?: mongoose.Types.ObjectId;
    createdBy?: mongoose.Types.ObjectId;
}

// Collapse internal whitespace runs and trim — "  Tesco   Extra " -> "Tesco Extra".
// Case is deliberately preserved: "Tesco Extra" and "Tesco extra" are NOT
// merged here, since nothing in this schema's indexes treats them as equal.
const normalizeName = (raw: string): string => raw.trim().replace(/\s+/g, " ");

async function main() {
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error("MONGO_URI is not set.");

    await mongoose.connect(uri);
    const db = mongoose.connection.db;
    if (!db) throw new Error("Database connection did not initialize.");
    const jobsCollection = db.collection<LegacyJobRow>("jobs");

    console.log(DRY_RUN ? "DRY RUN — no database changes were made." : "LIVE RUN — this will modify the database.");
    console.log("");

    const legacyJobs = await jobsCollection
        .find({ client: { $type: "string" } })
        .project<LegacyJobRow>({ _id: 1, client: 1, company: 1, createdBy: 1 })
        .toArray();

    console.log(`Found ${legacyJobs.length} job(s) with a legacy string client value.`);

    let emptyCleared = 0;
    let clientsCreated = 0;
    let clientsReused = 0;
    let jobsUpdated = 0;
    let groupsSkipped = 0;
    let errors = 0;

    // ── Empty/whitespace values just get cleared to null ─────────────────
    const emptyJobIds = legacyJobs.filter(j => !j.client || !j.client.trim()).map(j => j._id);
    if (emptyJobIds.length) {
        console.log(`${emptyJobIds.length} job(s) have an empty/whitespace client value — clearing to null.`);
        emptyCleared = emptyJobIds.length;
        if (!DRY_RUN) {
            await jobsCollection.updateMany(
                { _id: { $in: emptyJobIds } },
                { $set: { client: null } as unknown as Partial<LegacyJobRow> }
            );
        }
    }

    // ── Group everything else by company + exact normalized name ─────────
    // Multi-tenant: Company A's "Tesco" and Company B's "Tesco" are
    // unrelated and must never share a Client record — company is always
    // part of the grouping key, never deduplicated by name alone.
    const nonEmptyJobs = legacyJobs.filter(j => j.client && j.client.trim());

    interface Group {
        company: mongoose.Types.ObjectId;
        createdBy: mongoose.Types.ObjectId;
        name: string;
        jobIds: mongoose.Types.ObjectId[];
    }
    const groups = new Map<string, Group>();

    for (const job of nonEmptyJobs) {
        if (!job.company || !job.createdBy) {
            console.warn(`Skipping job ${job._id.toString()} — missing company or createdBy, needs manual review.`);
            groupsSkipped++;
            continue;
        }

        const name = normalizeName(job.client!);
        // Case-sensitive key on purpose — see normalizeName's comment.
        const key = `${job.company.toString()}::${name}`;

        let group = groups.get(key);
        if (!group) {
            group = { company: job.company, createdBy: job.createdBy, name, jobIds: [] };
            groups.set(key, group);
        }
        group.jobIds.push(job._id);
    }

    console.log(`Grouped into ${groups.size} distinct (company, client name) pair(s).`);
    console.log("");

    for (const group of groups.values()) {
        const action = DRY_RUN ? "would reuse-or-create Client and update" : "reusing-or-creating Client and updating";
        console.log(
            `Company: ${group.company.toString()} | Legacy name: "${group.name}" | ` +
            `Proposed Client name: "${group.name}" | Jobs: ${group.jobIds.length} | Action: ${action}`
        );

        if (DRY_RUN) continue;

        try {
            // Reuse an existing live Client for this exact company/name pair
            // if one already exists (idempotent — a second run of the real
            // migration won't create duplicates).
            let clientDoc = await ClientModel.findOne({
                company: group.company,
                name: group.name,
                isDeleted: false,
            });

            if (clientDoc) {
                clientsReused++;
            } else {
                clientDoc = await ClientModel.create({
                    company: group.company,
                    name: group.name,
                    createdBy: group.createdBy,
                });
                clientsCreated++;
            }

            // Writing the new ObjectId value onto a field this collection's
            // TS type still declares as `string` (the pre-migration shape) —
            // cast is intentional, not a type-safety gap.
            const result = await jobsCollection.updateMany(
                { _id: { $in: group.jobIds } },
                { $set: { client: clientDoc._id } as unknown as Partial<LegacyJobRow> }
            );
            jobsUpdated += result.modifiedCount;
        } catch (err) {
            console.error(`Failed to migrate group "${group.name}" for company ${group.company.toString()}:`, err);
            errors++;
        }
    }

    console.log("");
    console.log(DRY_RUN ? "Client migration dry run complete" : "Client migration complete");
    console.log("");
    console.log(`Clients created: ${clientsCreated}`);
    console.log(`Existing clients reused: ${clientsReused}`);
    console.log(`Jobs updated: ${jobsUpdated}`);
    console.log(`Empty client values cleared: ${emptyCleared}`);
    console.log(`Groups skipped: ${groupsSkipped}`);
    console.log(`Errors: ${errors}`);

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
