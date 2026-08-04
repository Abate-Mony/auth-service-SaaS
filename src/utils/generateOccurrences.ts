import dayjs from "../utils/dayjsSetup.js"; // instead of "dayjs"
import jobModel from "../models/jobModel.js";
import type { RecurringJob as RecurringJobType } from "../models/recurringJobModel.js";
import type { HydratedDocument } from "mongoose";
import recurringJobModel from "../models/recurringJobModel.js";

function getOccurrenceDates(
  recurring: HydratedDocument<RecurringJobType>,
  from: Date,
  until: Date
): Date[] {
  const dates: Date[] = [];
  const scheduleEnd = recurring.endDate ? dayjs(recurring.endDate) : null;
  const rangeEnd = dayjs(until);

  let cursor = dayjs(from).startOf("day");
  const rangeStart = dayjs(recurring.startDate).startOf("day");
  if (cursor.isBefore(rangeStart)) cursor = rangeStart;

  while (cursor.isSameOrBefore(rangeEnd, "day")) {
    if (scheduleEnd && cursor.isAfter(scheduleEnd, "day")) break;

    let matches = false;

    if (recurring.frequency === "daily") {
      const daysSinceStart = cursor.diff(rangeStart, "day");
      matches = daysSinceStart >= 0 && daysSinceStart % recurring.interval === 0;
    }

    if (recurring.frequency === "weekly") {
      const weeksSinceStart = cursor.diff(rangeStart, "week");
      const inIntervalWeek = weeksSinceStart >= 0 && weeksSinceStart % recurring.interval === 0;
      matches = inIntervalWeek && recurring.daysOfWeek?.includes(cursor.day());
    }

    if (recurring.frequency === "monthly") {
      const monthsSinceStart = cursor.diff(rangeStart, "month");
      matches =
        monthsSinceStart >= 0 &&
        monthsSinceStart % recurring.interval === 0 &&
        cursor.date() === rangeStart.date();
    }

    if (matches) dates.push(cursor.toDate());
    cursor = cursor.add(1, "day");
  }

  return dates;
}

export async function generateOccurrences(
  recurring: HydratedDocument<RecurringJobType>,
  until: Date
) {
  if (!recurring.active) return [];

  const template = await jobModel.findById(recurring.templateJob).lean();
  if (!template) throw new Error("Template job not found for recurring schedule");

  // Resume from wherever we last generated up to, so repeated calls don't
  // regenerate/duplicate past occurrences.
  const generateFrom = recurring.generatedUntil
    ? dayjs(recurring.generatedUntil).add(1, "day").toDate()
    : recurring.startDate;

  const occurrenceDates = getOccurrenceDates(recurring, generateFrom, until);
  if (!occurrenceDates.length) return [];

  // Belt-and-braces duplicate guard: skip any date that already has a Job
  // tied to this schedule (in case of overlapping manual + cron runs).
  const existing = await jobModel
    .find({ recurringJob: recurring._id, date: { $gte: generateFrom, $lte: until } })
    .distinct("date");
  const existingDateStrings = new Set(existing.map(d => dayjs(d).format("YYYY-MM-DD")));

  const toCreate = occurrenceDates
    .filter(d => !existingDateStrings.has(dayjs(d).format("YYYY-MM-DD")))
    .map(date => ({
      title: template.title,
      description: template.description,
      company: template.company,
      client: template.client,
      location: template.location,
      address: template.address,
      date,
      startTime: template.startTime,
      endTime: template.endTime,
      hours: template.hours,
      status: "published",
      priority: template.priority,
      requiredWorkers: template.requiredWorkers,
      supervisor: template.supervisor,
      payRate: template.payRate,
      chargeRate: template.chargeRate,
      notes: template.notes,
      instructions: template.instructions,
      isPublished: true,
      recurringJob: recurring._id,
      createdBy: recurring.createdBy,
    }));

  const createdJobs = toCreate.length ? await jobModel.insertMany(toCreate) : [];

  await recurringJobModel.updateOne(
    { _id: recurring._id },
    { generatedUntil: until }
  );

  return createdJobs;
}