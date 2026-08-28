import "dotenv/config";
import mongoose from "mongoose";

import User from "../models/userModel.js";
import NotificationPreferenceModel from "../models/NotificationPreferenceModel.js";

async function createNotificationPreferences() {
  try {
    await mongoose.connect(process.env.MONGO_URI!);

    console.log("Connected to MongoDB");

    const users = await User.find({
      company: {
        $exists: true,
        $ne: null,
      },
    }).select("_id company");

    console.log(`Found ${users.length} users`);

    let created = 0;
    let skipped = 0;

    for (const user of users) {
      const exists = await NotificationPreferenceModel.exists({
        user: user._id,
      });

      if (exists) {
        skipped++;
        continue;
      }

      await NotificationPreferenceModel.create({
        user: user._id,
        company: user.company!,
      });

      created++;
    }

    console.log("Migration complete");
    console.log(`Created: ${created}`);
    console.log(`Skipped: ${skipped}`);
  } catch (error) {
    console.error("Migration failed:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

createNotificationPreferences();