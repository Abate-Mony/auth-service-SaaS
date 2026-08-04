
import recurringJobModel from "../models/recurringJobModel.js";
import { generateOccurrences } from "./generateOccurrences.js";

export async function runDailyOccurrenceGeneration() {
  const active = await recurringJobModel.find({ active: true });
  const rollingWindow = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // always keep 30 days ahead

  for (const recurring of active) {
    try {
      await generateOccurrences(recurring, rollingWindow);
    } catch (err) {
      console.error(`Failed to generate occurrences for RecurringJob ${recurring._id}:`, err);
      // continue to the next schedule rather than letting one bad one block the rest
    }
  }
}