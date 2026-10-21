// Creates (or refreshes) a self-contained demo company for Apple/Google App
// Review — an owner account (used only to provision this data, never given
// to a reviewer) plus a worker account (the actual login submitted to both
// App Store Connect and Play Console, since the reviewed app is worker-only)
// with a daily recurring shift assigned, so a reviewer opening the app on
// whatever day they actually get to it sees a real, current shift rather
// than an empty state or a job whose date has already passed.
//
// Written as a direct-DB script (not a signup through the API) because the
// demo emails aren't real inboxes — normal signup needs a clickable
// verification/invite link, which can never arrive. This replicates exactly
// what authControler.ts's register() and invitationController.ts's
// acceptInvitation() do, just without the email step.
//
// Safe to re-run — existing owner/company/worker/schedule are reused rather
// than duplicated. The recurring schedule is self-sustaining once created:
// the app's own daily cron (runDailyOccurrenceGeneration) keeps generating
// fresh occurrences automatically, so you don't need to re-run this script
// just to refresh a stale date the way the old one-off-job version did.
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
import RecurringJob from "../models/recurringJobModel.js";
import NotificationPreferenceModel from "../models/NotificationPreferenceModel.js";
import { hashPassword } from "../utils/passwordUtils.js";
import { toUtcDay } from "../utils/dates.js";
import { generateOccurrences } from "../utils/generateOccurrences.js";

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

  // ── Recurring demo shift, every day, forever ─────────────────────────
  // A one-off job goes stale the moment its date passes — and App Review
  // can take anywhere from hours to days, so a single "today" job was
  // routinely already missed by the time a reviewer actually opened the
  // app. A daily RecurringJob instead self-sustains: the app's own
  // existing cron (runDailyOccurrenceGeneration, 1am UTC) keeps generating
  // fresh occurrences 30 days ahead forever, with defaultWorkers auto-
  // assigning the demo worker to every one — no need to ever re-run this
  // script again just to refresh a date.
  if (!DRY_RUN && company && owner && worker) {
    const today = toUtcDay(new Date());

    // Cleans up the old one-off job an earlier version of this script
    // created (isTemplate: false, no recurringJob link) — otherwise it's
    // orphaned clutter once this run replaces it with the recurring
    // version below. recurringJob: null is what distinguishes the actual
    // old stale job from a legitimately-generated occurrence of the new
    // recurring schedule below, which shares the same title and is also
    // isTemplate: false — without this, re-running the script would delete
    // and never replace today's real occurrence every time.
    const staleOneOffJob = await Job.findOne({
      company: company._id.toString(),
      title: "Office Cleaning — Demo Shift",
      isTemplate: false,
      recurringJob: null,
    });
    if (staleOneOffJob) {
      console.log("Removing the old one-off demo job (replaced by a recurring schedule).");
      await JobAssignment.deleteMany({ job: staleOneOffJob._id });
      await staleOneOffJob.deleteOne();
    }

    // Spans the full calendar day in the company's timezone rather than a
    // narrower business-hours window. Clock-in eligibility is checked
    // against the company's timezone (correct for a real workforce — the
    // shift happens at a real-world place and time, not wherever the
    // worker's phone thinks it is), so a reviewer outside the UK opening
    // the app at an unpredictable moment could otherwise land inside a
    // dead window (e.g. the old 06:00–22:00 UK shift was unclockable for
    // ~8 hours a day from timezones like Malaysia) and be unable to test
    // clock-in at all.
    const DEMO_START_TIME = "00:00";
    const DEMO_END_TIME = "23:59";
    const DEMO_MINUTES = 23 * 60 + 59;

    let templateJob = await Job.findOne({
      company: company._id.toString(),
      title: "Office Cleaning — Demo Shift",
      isTemplate: true,
    });
    if (!templateJob) {
      console.log("Creating demo job template.");
      templateJob = await Job.create({
        company: company._id.toString(),
        title: "Office Cleaning — Demo Shift",
        description: "Sample job for App Review — demonstrates job details, clock-in/out and timesheets.",
        location: "123 Demo Street, London",
        address: "123 Demo Street, London",
        coordinates: { lat: 51.5074, lng: -0.1278 },
        date: today,
        startTime: DEMO_START_TIME,
        endTime: DEMO_END_TIME,
        minutes: DEMO_MINUTES,
        status: "published",
        isTemplate: true,
        requiredWorkers: 1,
        payRate: 15,
        chargeType: "hourly",
        chargeRate: 25,
        createdBy: owner._id,
      });
    } else if (templateJob.startTime !== DEMO_START_TIME || templateJob.endTime !== DEMO_END_TIME) {
      console.log("Widening demo job template to a full-day window.");
      templateJob.startTime = DEMO_START_TIME;
      templateJob.endTime = DEMO_END_TIME;
      templateJob.minutes = DEMO_MINUTES;
      await templateJob.save();
    }

    let recurring = await RecurringJob.findOne({ company: company._id, templateJob: templateJob._id });
    if (!recurring) {
      console.log("Creating daily recurring schedule for the demo job.");
      recurring = await RecurringJob.create({
        templateJob: templateJob._id,
        frequency: "daily",
        interval: 1,
        startDate: today,
        defaultWorkers: [worker._id],
        active: true,
        createdBy: owner._id,
        company: company._id,
      });
    } else {
      console.log("Recurring demo schedule already exists.");
      // defaultWorkers is only set at creation above — if the worker
      // account was ever recreated (e.g. a tester changed the original
      // demo worker's email via their own Edit Profile, orphaning it from
      // this schedule), an existing recurring schedule would otherwise
      // keep silently assigning new occurrences to the old worker id
      // forever. Keep it pointed at whichever worker currently holds
      // workerEmail.
      if (!recurring.defaultWorkers?.some(id => id.equals(worker._id))) {
        console.log("Re-pointing the recurring schedule's default worker to the current account.");
        recurring.defaultWorkers = [worker._id];
        await recurring.save();
      }
    }

    // Generates (only) today's occurrence right now rather than waiting for
    // tomorrow's 1am cron — re-running this script is harmless either way,
    // generateOccurrences skips dates that already exist.
    await generateOccurrences(recurring, today);

    // The template change above only affects occurrences generated from
    // here on — any already-existing upcoming occurrence (including today's,
    // which generateOccurrences just skipped since it already exists) was
    // cloned from the template before this run and still has the old
    // narrower window. Widen those too so the fix is live immediately
    // rather than waiting ~30 days for the old ones to roll off.
    const widenResult = await Job.updateMany(
      {
        recurringJob: recurring._id,
        isTemplate: false,
        date: { $gte: today },
        status: { $nin: ["completed", "cancelled"] },
      },
      { $set: { startTime: DEMO_START_TIME, endTime: DEMO_END_TIME, minutes: DEMO_MINUTES } }
    );
    if (widenResult.modifiedCount > 0) {
      console.log(`Widened ${widenResult.modifiedCount} already-generated upcoming occurrence(s) to the full-day window.`);
    }

    // Covers both: an occurrence generated under the old defaultWorkers
    // before the re-point above (so generateOccurrences never created an
    // assignment for the current worker at all), and the ordinary
    // pending → accepted step for whatever it did create. Scoped to
    // upcoming, non-cancelled occurrences only — never touches history.
    const upcomingOccurrences = await Job.find({
      recurringJob: recurring._id,
      isTemplate: false,
      date: { $gte: today },
      status: { $nin: ["completed", "cancelled"] },
    }).select("_id");

    for (const occurrence of upcomingOccurrences) {
      let assignment = await JobAssignment.findOne({ job: occurrence._id, worker: worker._id });
      if (!assignment) {
        console.log(`Assigning the current worker to an occurrence missing it (job ${occurrence._id}).`);
        assignment = await JobAssignment.create({
          job: occurrence._id,
          worker: worker._id,
          createdBy: owner._id,
          company: company._id,
          payRate: templateJob.payRate,
          fullname: worker.fullname,
        });
      }
      if (assignment.status !== "accepted") {
        assignment.status = "accepted";
        assignment.acceptedAt = new Date();
        await assignment.save();
      }
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
