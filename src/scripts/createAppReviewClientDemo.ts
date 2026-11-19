// Creates (or refreshes) the client-portal login for the App Review demo
// company created by createAppReviewDemo.ts — gives Apple/Google reviewers
// (or anyone testing the client portal) a login scoped to that same company,
// using the same password as the owner/worker demo accounts.
//
// Written as a direct-DB script for the same reason as createAppReviewDemo.ts:
// the demo email isn't a real inbox, and the only normal way to get a
// client-portal account is clicking a real invite email
// (clientPortalInvitationController.ts), which can never arrive here.
//
// Safe to re-run — looks up the company via --owner-email (must already
// exist, i.e. run createAppReviewDemo.js first) and reuses the existing
// client/account rather than duplicating them.
//
// Run with:
//   node dist/scripts/createAppReviewClientDemo.js \
//     --owner-email=app-review-owner@onclockly.com \
//     --client-email=app-review-client@onclockly.com \
//     --password=AppReview2026! \
//     [--dry-run]
// (build first with `npm run build`.)
import * as dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import mongoose from "mongoose";
import Company from "../models/company.js";
import Client from "../models/clientModel.js";
import User from "../models/userModel.js";
import { hashPassword } from "../utils/passwordUtils.js";

const DRY_RUN = process.argv.includes("--dry-run");

const getArg = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  const arg = process.argv.find(a => a.startsWith(prefix));
  return arg?.slice(prefix.length);
};

async function main() {
  const ownerEmail = getArg("owner-email")?.trim().toLowerCase();
  const clientEmail = getArg("client-email")?.trim().toLowerCase();
  const password = getArg("password");

  if (!ownerEmail || !clientEmail || !password) {
    throw new Error(
      "Usage: --owner-email=<existing app-review owner email> --client-email=<email> --password=<password> [--dry-run]"
    );
  }
  if (password.length < 8) throw new Error("--password must be at least 8 characters.");

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set.");
  await mongoose.connect(uri);

  console.log(DRY_RUN ? "DRY RUN — no database changes were made." : "LIVE RUN — this will modify the database.");
  console.log("");

  const owner = await User.findOne({ email: ownerEmail }).select("company");
  if (!owner || !owner.company) {
    throw new Error(
      `No company found for owner "${ownerEmail}" — run createAppReviewDemo.js first to create the demo company.`
    );
  }
  const company = await Company.findById(owner.company).select("name owner");
  if (!company) throw new Error(`Owner's company (${owner.company}) no longer exists.`);

  console.log(`Using company: ${company.name} (${company._id})`);

  const existingUser = await User.findOne({ email: clientEmail }).select("role client isActive");
  if (existingUser && existingUser.role !== "client") {
    throw new Error(`A user with email "${clientEmail}" already exists with role "${existingUser.role}" — this script only creates/resets client-portal accounts.`);
  }

  let client = existingUser
    ? await Client.findById(existingUser.client)
    : await Client.findOne({ company: company._id, lifecycle: "client", status: "active", name: "App Review Demo Client" });

  const hashed = await hashPassword(password);

  if (existingUser) {
    console.log(`${DRY_RUN ? "Would reset password for" : "Resetting password for"} existing client-portal account: ${clientEmail}`);
    if (!DRY_RUN) {
      await User.updateOne({ _id: existingUser._id }, { $set: { password: hashed, isActive: true, isVerified: true } });
    }
  } else {
    if (client) {
      console.log(`${DRY_RUN ? "Would reuse" : "Reusing"} existing client: ${client.name} (${client._id})`);
    } else {
      console.log(`${DRY_RUN ? "Would create" : "Creating"} client: App Review Demo Client`);
      if (!DRY_RUN) {
        client = await Client.create({ company: company._id, name: "App Review Demo Client", lifecycle: "client", status: "active" });
      }
    }
    console.log(`${DRY_RUN ? "Would create" : "Creating"} client-portal account: ${clientEmail}`);
    if (!DRY_RUN) {
      await User.create({
        fullname: "App Review Client",
        email: clientEmail,
        password: hashed,
        role: "client",
        client: client!._id,
        clientRole: "owner",
        company: company._id,
        createdBy: company.owner,
        isVerified: true,
        isActive: true,
      });
    }
  }

  console.log("");
  console.log("Demo client-portal credentials (same password as the owner/worker demo accounts):");
  console.log(`  Client portal: ${clientEmail} / ${password}`);

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
