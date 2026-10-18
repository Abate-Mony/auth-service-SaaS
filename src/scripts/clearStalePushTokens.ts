// One-off cleanup for the stale-push-token bug fixed in workerController.ts
// (saveExpoPushToken/savePushSubscription previously only ever ADDED a
// device's token to whichever account registered it, never removing it
// from whichever OTHER account had the same token from an earlier login on
// the same device — so an old account could keep receiving a device's
// notifications indefinitely after someone logged out of it). That fix only
// prevents new duplicates going forward; this clears out whatever duplicate
// tokens already exist from everyone's logout-then-switch-account history.
//
// Safe, not destructive to anything that matters: every affected device
// just re-registers its token the next time the app opens or the
// notification-permission check runs (see ensureNotificationPermission /
// ensurePushSubscription in both the mobile app and work.wk), at which
// point the new "steal it away from other accounts" logic takes over
// correctly. No user has to re-grant permission or do anything themselves.
//
// Run with:
//   node dist/scripts/clearStalePushTokens.js [--dry-run]
// (build first with `npm run build`.)
import * as dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import mongoose from "mongoose";
import User from "../models/userModel.js";

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set.");
  await mongoose.connect(uri);

  console.log(DRY_RUN ? "DRY RUN — no database changes were made." : "LIVE RUN — this will modify the database.");
  console.log("");

  const withExpoTokens = await User.countDocuments({ expoPushTokens: { $exists: true, $not: { $size: 0 } } });
  const withWebPush = await User.countDocuments({ pushSubscriptions: { $exists: true, $not: { $size: 0 } } });

  console.log(`Users with at least one Expo push token: ${withExpoTokens}`);
  console.log(`Users with at least one web push subscription: ${withWebPush}`);

  if (!DRY_RUN) {
    const expoResult = await User.updateMany(
      { expoPushTokens: { $exists: true, $not: { $size: 0 } } },
      { $set: { expoPushTokens: [] } }
    );
    const webPushResult = await User.updateMany(
      { pushSubscriptions: { $exists: true, $not: { $size: 0 } } },
      { $set: { pushSubscriptions: [] } }
    );
    console.log("");
    console.log(`Cleared expoPushTokens on ${expoResult.modifiedCount} users.`);
    console.log(`Cleared pushSubscriptions on ${webPushResult.modifiedCount} users.`);
  } else {
    console.log("");
    console.log("DRY RUN — no database changes were made.");
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
