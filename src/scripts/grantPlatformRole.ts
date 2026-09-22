// Grants platform-admin access to an existing user. This is the only
// supported way to create the first Super Admin (and every one after) — see
// INPRN_SUPER_ADMIN_BACKEND_CLAUDE_IMPLEMENTATION_BRIEF.md section 7: there
// is deliberately no public API for a user to grant themselves platformRole.
//
// Run with: node dist/scripts/grantPlatformRole.js --email=someone@inprn.com --role=super_admin [--dry-run]
// (build first with `npm run build`.)
import * as dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import mongoose from "mongoose";
import User from "../models/userModel.js";
import { PLATFORM_ROLES, PlatformRole } from "../utils/platformRoles.js";

const DRY_RUN = process.argv.includes("--dry-run");

const getArg = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  const arg = process.argv.find(a => a.startsWith(prefix));
  return arg?.slice(prefix.length);
};

async function main() {
  const email = getArg("email")?.trim().toLowerCase();
  const role = getArg("role")?.trim() as PlatformRole | undefined;

  if (!email) throw new Error("Usage: --email=<user email> --role=<platform role> [--dry-run]");
  if (!role || !PLATFORM_ROLES.includes(role)) {
    throw new Error(`--role must be one of: ${PLATFORM_ROLES.join(", ")}`);
  }

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set.");
  await mongoose.connect(uri);

  console.log(DRY_RUN ? "DRY RUN — no database changes were made." : "LIVE RUN — this will modify the database.");
  console.log("");

  const user = await User.findOne({ email }).select("_id email fullname platformRole");
  if (!user) {
    // Fails safely — never creates a user. Platform access can only be
    // granted to an existing account.
    throw new Error(`No user found with email "${email}". Create the account first (through normal signup), then run this script.`);
  }

  if (user.platformRole === role) {
    console.log(`${user.email} already has platformRole "${role}" — nothing to do.`);
  } else {
    console.log(
      `${DRY_RUN ? "Would grant" : "Granting"} platformRole "${role}" to ${user.email} (${user.fullname})` +
      (user.platformRole ? ` — replacing existing "${user.platformRole}".` : ".")
    );
    if (!DRY_RUN) {
      await User.updateOne({ _id: user._id }, { $set: { platformRole: role } });
    }
  }

  console.log("");
  console.log("Platform role grant:");
  console.log(`  User:  ${user.fullname}`);
  console.log(`  Email: ${user.email}`);
  console.log(`  Role:  ${role}`);

  if (DRY_RUN) {
    console.log("");
    console.log("DRY RUN — no database changes were made.");
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error("Grant failed:", err);
  process.exit(1);
});
