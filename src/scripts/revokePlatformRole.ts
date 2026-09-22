// Revokes platform-admin access from a user. Counterpart to
// grantPlatformRole.ts — see that file's header for the same run pattern.
//
// Run with: node dist/scripts/revokePlatformRole.js --email=someone@inprn.com [--dry-run]
// (build first with `npm run build`.)
import * as dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import mongoose from "mongoose";
import User from "../models/userModel.js";

const DRY_RUN = process.argv.includes("--dry-run");

const getArg = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  const arg = process.argv.find(a => a.startsWith(prefix));
  return arg?.slice(prefix.length);
};

async function main() {
  const email = getArg("email")?.trim().toLowerCase();
  if (!email) throw new Error("Usage: --email=<user email> [--dry-run]");

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set.");
  await mongoose.connect(uri);

  console.log(DRY_RUN ? "DRY RUN — no database changes were made." : "LIVE RUN — this will modify the database.");
  console.log("");

  const user = await User.findOne({ email }).select("_id email fullname platformRole");
  if (!user) throw new Error(`No user found with email "${email}".`);

  if (!user.platformRole) {
    console.log(`${user.email} has no platform role — nothing to do.`);
  } else {
    // Prevent accidentally locking every platform admin out at once — at
    // least one super_admin must remain after this runs. See the brief's
    // "prevent self-lockout" guidance; enforced here since this script is
    // the only way platformRole ever changes.
    if (user.platformRole === "super_admin") {
      const remainingSuperAdmins = await User.countDocuments({ platformRole: "super_admin", _id: { $ne: user._id } });
      if (remainingSuperAdmins === 0) {
        throw new Error(
          `Refusing to revoke: ${user.email} is the last super_admin. Grant another user super_admin first.`
        );
      }
    }

    console.log(`${DRY_RUN ? "Would revoke" : "Revoking"} platformRole "${user.platformRole}" from ${user.email} (${user.fullname}).`);
    if (!DRY_RUN) {
      await User.updateOne({ _id: user._id }, { $set: { platformRole: null } });
    }
  }

  if (DRY_RUN) {
    console.log("");
    console.log("DRY RUN — no database changes were made.");
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error("Revoke failed:", err);
  process.exit(1);
});
