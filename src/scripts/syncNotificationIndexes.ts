// Run with: node dist/scripts/syncNotificationIndexes.js
// (build first with `npm run build`.)
//
// The app connects with autoIndex: false (see src/db/connections.ts /
// server.ts) — production never auto-builds indexes from schema changes,
// so a new index (like Notification's 30-day TTL) only exists in the
// Mongoose schema until this is run once against the real database.
// Safe to re-run: syncIndexes() reconciles existing indexes to match the
// current schema rather than duplicating anything.
import * as dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import mongoose from "mongoose";
import Notification from "../models/Notification.js";

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");

  await mongoose.connect(uri);

  const result = await Notification.syncIndexes();
  console.log("Notification indexes synced:", result);

  await mongoose.disconnect();
}

main().catch(err => {
  console.error("Syncing Notification indexes failed:", err);
  process.exit(1);
});
