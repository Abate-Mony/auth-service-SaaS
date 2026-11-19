// Creates (or resets the password on) a local test account for the
// client portal — mirrors createPlatformAdmin.ts's structure, but for a
// role:"client" User instead of a platformRole account. There is no
// script-free way to get a client-portal login outside the real invite
// flow (clientPortalInvitationController.ts), which needs a clickable
// email link that can't arrive for a throwaway local account.
//
// Safe to re-run: an existing client account for --email just gets its
// password reset rather than erroring, same as "reusing it, resetting
// password" in createAppReviewDemo.ts.
//
// Run with:
//   node dist/scripts/createClientPortalTestAccount.js \
//     --email=client@local.test [--password=...] [--company=<companyId>] \
//     [--client-name="Local Test Client"] [--client-role=owner] [--dry-run]
// (build first with `npm run build`.)
//
// If --company is omitted, the oldest company in the database is used. If
// --password is omitted, a strong random one is generated and printed
// ONCE — write it down immediately, it is not recoverable afterward (only
// its bcrypt hash is stored, same as every other password in this app).
import * as dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import crypto from "crypto";
import mongoose from "mongoose";
import Company from "../models/company.js";
import Client from "../models/clientModel.js";
import User from "../models/userModel.js";
import { hashPassword } from "../utils/passwordUtils.js";

const DRY_RUN = process.argv.includes("--dry-run");
const CLIENT_ROLES = ["owner", "manager", "booking", "billing", "viewer"] as const;
type ClientRole = (typeof CLIENT_ROLES)[number];

const getArg = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  const arg = process.argv.find(a => a.startsWith(prefix));
  return arg?.slice(prefix.length);
};

const generatePassword = (): string => crypto.randomBytes(18).toString("base64url");

async function main() {
  const email = getArg("email")?.trim().toLowerCase();
  const companyId = getArg("company")?.trim();
  const clientName = getArg("client-name")?.trim() || "Local Test Client";
  const clientRole = (getArg("client-role")?.trim() as ClientRole | undefined) ?? "owner";
  let password = getArg("password");

  if (!email) throw new Error("Usage: --email=<email> [--password=...] [--company=<companyId>] [--client-name=...] [--client-role=owner] [--dry-run]");
  if (!CLIENT_ROLES.includes(clientRole)) throw new Error(`--client-role must be one of: ${CLIENT_ROLES.join(", ")}`);
  if (password && password.length < 8) throw new Error("--password must be at least 8 characters.");

  const generatedPassword = !password;
  if (!password) password = generatePassword();

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set.");
  await mongoose.connect(uri);

  console.log(DRY_RUN ? "DRY RUN — no database changes were made." : "LIVE RUN — this will modify the database.");
  console.log("");

  const company = companyId
    ? await Company.findById(companyId).select("name owner")
    : await Company.findOne().sort({ createdAt: 1 }).select("name owner");
  if (!company) {
    throw new Error(
      companyId
        ? `No company found with id "${companyId}".`
        : "No companies exist in this database yet — sign up through the app first, or pass --company=<id>."
    );
  }

  const existingUser = await User.findOne({ email }).select("role client isActive");

  if (existingUser && existingUser.role !== "client") {
    throw new Error(`A user with email "${email}" already exists with role "${existingUser.role}" — this script only creates/resets client-portal accounts.`);
  }

  let client = existingUser
    ? await Client.findById(existingUser.client)
    : await Client.findOne({ company: company._id, lifecycle: "client", status: "active" }).sort({ createdAt: 1 });

  console.log(`${DRY_RUN ? "Would use" : "Using"} company: ${company.name} (${company._id})`);

  if (existingUser) {
    console.log(`${DRY_RUN ? "Would reset password for" : "Resetting password for"} existing client-portal account: ${email}`);
  } else {
    if (client) {
      console.log(`${DRY_RUN ? "Would reuse" : "Reusing"} existing client: ${client.name} (${client._id})`);
    } else {
      console.log(`${DRY_RUN ? "Would create" : "Creating"} client: ${clientName}`);
      if (!DRY_RUN) {
        client = await Client.create({ company: company._id, name: clientName, lifecycle: "client", status: "active" });
      }
    }
    console.log(`${DRY_RUN ? "Would create" : "Creating"} client-portal account:`);
    console.log(`  Email:       ${email}`);
    console.log(`  Client role: ${clientRole}`);
  }

  if (!DRY_RUN) {
    const hashed = await hashPassword(password);
    if (existingUser) {
      await User.updateOne({ _id: existingUser._id }, { $set: { password: hashed, isActive: true, isVerified: true } });
    } else {
      await User.create({
        fullname: clientName,
        email,
        password: hashed,
        role: "client",
        client: client!._id,
        clientRole,
        company: company._id,
        createdBy: company.owner,
        isVerified: true,
        isActive: true,
      });
    }
  }

  console.log("");
  if (generatedPassword) {
    console.log("Generated password (shown once — save it now, it cannot be retrieved later):");
    console.log(`  ${password}`);
  } else {
    console.log("Password set from --password.");
  }

  if (DRY_RUN) {
    console.log("");
    console.log("DRY RUN — no database changes were made.");
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error("Failed:", err);
  process.exit(1);
});
