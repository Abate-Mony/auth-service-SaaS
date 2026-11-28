// One-off data repair: removes repeated parts from existing jobs' address
// and location, e.g.
//   "15 High St, Corsham SN13 0ES, UK, Corsham, SN13 0ES"
//   → "15 High St, Corsham SN13 0ES, UK"
// New and edited jobs are tidied automatically (jobModel.ts hooks); this
// fixes the ones saved before that.
//
// Run with (build first with `npm run build`):
//   npm run migrate:tidy-job-addresses:dry-run   → lists what would change
//   npm run migrate:tidy-job-addresses           → applies it
//
// Only removes parts that repeat or are fully covered by another part —
// see tidyAddress(). Idempotent: running it twice changes nothing more.
import * as dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import mongoose from "mongoose";
import Job from "../models/jobModel.js";
import { tidyAddress } from "../utils/addressFormat.js";

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error("MONGO_URI is not set.");
    await mongoose.connect(uri);

    console.log(DRY_RUN ? "DRY RUN — no database changes were made." : "LIVE RUN — this will modify the database.");
    console.log("");

    const cursor = Job.find({ $or: [{ address: { $regex: "," } }, { location: { $regex: "," } }] })
        .select("_id title address location")
        .lean()
        .cursor();

    let checked = 0;
    let changed = 0;
    const ops: { updateOne: { filter: { _id: unknown }; update: { $set: Record<string, string> } } }[] = [];

    for await (const job of cursor) {
        checked++;
        const set: Record<string, string> = {};
        const address = tidyAddress(job.address);
        const location = tidyAddress(job.location);
        if (job.address && address !== job.address) set.address = address;
        if (job.location && location !== job.location) set.location = location;
        if (!Object.keys(set).length) continue;

        changed++;
        if (changed <= 25 || DRY_RUN) {
            console.log(`• ${job.title} (${job._id})`);
            if (set.address) console.log(`    address:  "${job.address}"\n           → "${set.address}"`);
            if (set.location) console.log(`    location: "${job.location}"\n           → "${set.location}"`);
        }
        // Raw collection write so the hooks don't run twice and timestamps aren't touched.
        ops.push({ updateOne: { filter: { _id: job._id }, update: { $set: set } } });
        if (!DRY_RUN && ops.length >= 500) {
            await Job.collection.bulkWrite(ops as any, { ordered: false });
            ops.length = 0;
        }
    }
    if (!DRY_RUN && ops.length) await Job.collection.bulkWrite(ops as any, { ordered: false });

    console.log("");
    console.log(`Checked ${checked} job(s); ${changed} ${DRY_RUN ? "would be" : "were"} tidied.`);
    await mongoose.disconnect();
}

main().catch(async err => {
    console.error(err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
