// Creates (or refreshes) a self-contained demo company for Apple/Google App
// Review — an owner account (used only to provision this data, never given
// to a reviewer) plus a worker account (the actual login submitted to both
// App Store Connect and Play Console, since the reviewed app is worker-only)
// with a sample job assigned and scheduled for today, so a reviewer opening
// the app sees a real shift to look at instead of an empty state.
//
// Written as a direct-DB script (not a signup through the API) because the
// demo emails aren't real inboxes — normal signup needs a clickable
// verification/invite link, which can never arrive. This replicates exactly
// what authControler.ts's register() and invitationController.ts's
// acceptInvitation() do, just without the email step.
//
// Safe to re-run: existing owner/company/worker are reused rather than
// duplicated, and the sample job's date is refreshed to "today" every run —
// re-run this close to when you expect the review to actually happen if a
// submission sits for a few days first.
//
// Run with:
//   node dist/scripts/createAppReviewDemo.js \
//     --owner-email=app-review-owner@onclockly.com \
//     --worker-email=app-review-worker@onclockly.com \
//     --password=AppReview2026! \
//     [--dry-run]
// (build first with `npm run build`.)
import * as dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import mongoose from "mongoose";
import Company from "../models/company.js";
import User from "../models/userModel.js";
import Job from "../models/jobModel.js";
import JobAssignment from "../models/JobAssignment.js";
import NotificationPreferenceModel from "../models/NotificationPreferenceModel.js";
import { hashPassword } from "../utils/passwordUtils.js";
import { toUtcDay } from "../utils/dates.js";

const DRY_RUN = process.argv.includes("--dry-run");

const getArg = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  const arg = process.argv.find(a => a.startsWith(prefix));
  return arg?.slice(prefix.length);
};

async function main() {
  const ownerEmail = getArg("owner-email")?.trim().toLowerCase();
  const workerEmail = getArg("worker-email")?.trim().toLowerCase();
  const password = getArg("password");

  if (!ownerEmail || !workerEmail || !password) {
    throw new Error(
      "Usage: --owner-email=<email> --worker-email=<email> --password=<password> [--dry-run]"
    );
  }
  if (password.length < 8) throw new Error("--password must be at least 8 characters.");
  if (ownerEmail === workerEmail) throw new Error("--owner-email and --worker-email must be different.");

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set.");
  await mongoose.connect(uri);

  console.log(DRY_RUN ? "DRY RUN — no database changes were made." : "LIVE RUN — this will modify the database.");
  console.log("");

  const hashed = await hashPassword(password);

  // ── Owner + company ──────────────────────────────────────────────────
  let owner = await User.findOne({ email: ownerEmail });
  let company = owner?.company ? await Company.findById(owner.company) : null;

  if (owner && !company) {
    throw new Error(`User ${ownerEmail} exists but has no company — refusing to guess, check the DB manually.`);
  }

  if (!owner) {
    console.log(`${DRY_RUN ? "Would create" : "Creating"} owner: ${ownerEmail}`);
    if (!DRY_RUN) {
      owner = await User.create({
        fullname: "App Review Owner",
        email: ownerEmail,
        password: hashed,
        role: "owner",
        isVerified: true,
        isActive: true,
      });

      company = await Company.create({
        name: "OnClockly App Review Demo",
        businessType: "Cleaning Company",
        size: "1–10 workers",
        owner: owner._id,
        isActive: true,
        plan: "professional",
      });

      owner.company = company._id;
      await owner.save();

      await NotificationPreferenceModel.create({ company: company._id, user: owner._id }).catch(err =>
        console.error("Failed to create owner notification preferences:", err)
      );
    }
  } else {
    console.log(`Owner ${ownerEmail} already exists — reusing company "${company?.name}".`);
    if (!DRY_RUN) {
      owner.password = hashed;
      await owner.save();
    }
  }

  // ── Worker ────────────────────────────────────────────────────────────
  let worker = await User.findOne({ email: workerEmail });

  if (!worker) {
    console.log(`${DRY_RUN ? "Would create" : "Creating"} worker: ${workerEmail}`);
    if (!DRY_RUN && company && owner) {
      worker = await User.create({
        fullname: "App Review Worker",
        email: workerEmail,
        password: hashed,
        role: "worker",
        company: company._id,
        createdBy: owner._id,
        isVerified: true,
        isActive: true,
      });

      await NotificationPreferenceModel.create({ company: company._id, user: worker._id }).catch(err =>
        console.error("Failed to create worker notification preferences:", err)
      );
    }
  } else {
    console.log(`Worker ${workerEmail} already exists — reusing it, resetting password.`);
    if (!DRY_RUN) {
      worker.password = hashed;
      await worker.save();
    }
  }

  // ── Sample job + assignment, dated today ─────────────────────────────
  if (!DRY_RUN && company && owner && worker) {
    const today = toUtcDay(new Date());

    let job = await Job.findOne({ company: company._id.toString(), title: "Office Cleaning — Demo Shift", isTemplate: false });
    if (job) {
      console.log("Refreshing existing demo job's date to today.");
      job.date = today;
      job.status = "published";
      await job.save();
    } else {
      console.log("Creating demo job scheduled for today.");
      job = await Job.create({
        company: company._id.toString(),
        title: "Office Cleaning — Demo Shift",
        description: "Sample job for App Review — demonstrates job details, clock-in/out and timesheets.",
        location: "123 Demo Street, London",
        address: "123 Demo Street, London",
        coordinates: { lat: 51.5074, lng: -0.1278 },
        date: today,
        startTime: "06:00",
        endTime: "22:00",
        minutes: 16 * 60,
        status: "published",
        requiredWorkers: 1,
        payRate: 15,
        chargeType: "hourly",
        chargeRate: 25,
        createdBy: owner._id,
      });
    }

    const existingAssignment = await JobAssignment.findOne({ job: job._id, worker: worker._id });
    if (existingAssignment) {
      console.log("Worker already assigned to the demo job.");
    } else {
      console.log("Assigning worker to the demo job.");
      await JobAssignment.create({
        fullname: worker.fullname,
        job: job._id,
        worker: worker._id,
        createdBy: owner._id,
        company: company._id,
        status: "accepted",
        acceptedAt: new Date(),
        payRate: 15,
      });
    }
  }

  console.log("");
  console.log("Demo credentials (same for both accounts):");
  console.log(`  Owner  (internal setup only): ${ownerEmail} / ${password}`);
  console.log(`  Worker (give this to Apple + Google): ${workerEmail} / ${password}`);

  if (DRY_RUN) {
    console.log("");
    console.log("DRY RUN — no database changes were made.");
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error("Setup failed:", err);
  process.exit(1);
});
