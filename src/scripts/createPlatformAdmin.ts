// Creates a brand-new, dedicated platform-admin account — a pure platform-ops
// identity with no company, not a promoted tenant user. For promoting an
// existing account instead, use grantPlatformRole.ts (that's the safer path
// when a real person already has a normal INPRN account).
//
// role is set to "admin" (not "worker"/"manager") because userModel.ts only
// allows a user to have no `company` when role is "admin" or "owner" — this
// account isn't a member of any tenant company, so it needs one of those two.
// "admin" was chosen over "owner" since this user doesn't own a company.
//
// Run with:
//   node dist/scripts/createPlatformAdmin.js --email=ops@inprn.com --fullname="Platform Ops" [--password=...] [--role=super_admin] [--dry-run]
// (build first with `npm run build`.)
//
// If --password is omitted, a strong random one is generated and printed
// ONCE — write it down immediately, it is not recoverable afterward (only
// its bcrypt hash is stored, same as every other password in this app).
import * as dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import crypto from "crypto";
import mongoose from "mongoose";
import User from "../models/userModel.js";
import { hashPassword } from "../utils/passwordUtils.js";
import { PLATFORM_ROLES, PlatformRole } from "../utils/platformRoles.js";

const DRY_RUN = process.argv.includes("--dry-run");

const getArg = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  const arg = process.argv.find(a => a.startsWith(prefix));
  return arg?.slice(prefix.length);
};

const generatePassword = (): string => crypto.randomBytes(18).toString("base64url");

async function main() {
  const email = getArg("email")?.trim().toLowerCase();
  const fullname = getArg("fullname")?.trim();
  const role = (getArg("role")?.trim() as PlatformRole | undefined) ?? "super_admin";
  let password = getArg("password");

  if (!email) throw new Error("Usage: --email=<email> --fullname=<name> [--password=...] [--role=super_admin] [--dry-run]");
  if (!fullname) throw new Error("--fullname is required.");
  if (!PLATFORM_ROLES.includes(role)) throw new Error(`--role must be one of: ${PLATFORM_ROLES.join(", ")}`);
  if (password && password.length < 8) throw new Error("--password must be at least 8 characters.");

  const generatedPassword = !password;
  if (!password) password = generatePassword();

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set.");
  await mongoose.connect(uri);

  console.log(DRY_RUN ? "DRY RUN — no database changes were made." : "LIVE RUN — this will modify the database.");
  console.log("");

  const existing = await User.findOne({ email }).select("_id");
  if (existing) {
    throw new Error(
      `A user with email "${email}" already exists. Use "npm run platform:grant -- --email=${email} --role=${role}" to promote it instead — this script only creates new accounts.`
    );
  }

  console.log(`${DRY_RUN ? "Would create" : "Creating"} dedicated platform admin account:`);
  console.log(`  Email:        ${email}`);
  console.log(`  Full name:    ${fullname}`);
  console.log(`  Company role: admin (no company — platform-only account)`);
  console.log(`  Platform role: ${role}`);

  if (!DRY_RUN) {
    const hashed = await hashPassword(password);
    await User.create({
      email,
      fullname,
      password: hashed,
      role: "admin",
      platformRole: role,
      isVerified: true,
      isActive: true,
    });
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
  console.error("Create failed:", err);
  process.exit(1);
});
