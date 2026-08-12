import dayjs from "../utils/dayjsSetup.js";
import jobModel from "../models/jobModel.js";
import recurringJobModel from "../models/recurringJobModel.js";
import type { RecurringJob as RecurringJobType } from "../models/recurringJobModel.js";
import type { HydratedDocument } from "mongoose";
import { toUtcDay, toUtcDayKey } from "./dates.js";

function getOccurrenceDates(
  recurring: HydratedDocument<RecurringJobType>,
  from: Date,
  until: Date
): Date[] {
  const dates: Date[] = [];

  // All cursor arithmetic happens in UTC so the dates we build match the
  // UTC-midnight dates we store. Mixing local and UTC here is what caused
  // the duplicate guard to never match.
  const scheduleEnd = recurring.endDate ? dayjs.utc(recurring.endDate) : null;
  const rangeEnd = dayjs.utc(until).startOf("day");
  const rangeStart = dayjs.utc(recurring.startDate).startOf("day");

  let cursor = dayjs.utc(from).startOf("day");
  if (cursor.isBefore(rangeStart)) cursor = rangeStart;

  const remaining = recurring.maxOccurrences
    ? recurring.maxOccurrences - (recurring.occurrencesGenerated ?? 0)
    : Infinity;
  if (remaining <= 0) return [];

  while (cursor.isSameOrBefore(rangeEnd, "day")) {
    if (scheduleEnd && cursor.isAfter(scheduleEnd, "day")) break;
    if (dates.length >= remaining) break;

    let matches = false;

    if (recurring.frequency === "daily") {
      const daysSinceStart = cursor.diff(rangeStart, "day");
      matches = daysSinceStart >= 0 && daysSinceStart % recurring.interval === 0;
    }

    if (recurring.frequency === "weekly") {
      // Align week counting to week starts — diff("week") between two
      // arbitrary days truncates and can land a day in the wrong interval week.
      const weeksSinceStart = cursor
        .startOf("week")
        .diff(rangeStart.startOf("week"), "week");
      const inIntervalWeek = weeksSinceStart >= 0 && weeksSinceStart % recurring.interval === 0;
      matches = inIntervalWeek && !!recurring.daysOfWeek?.includes(cursor.day());
    }

    if (recurring.frequency === "monthly") {
      const monthsSinceStart = cursor.diff(rangeStart, "month");
      const inIntervalMonth = monthsSinceStart >= 0 && monthsSinceStart % recurring.interval === 0;

      if (inIntervalMonth) {
        if (recurring.monthlyMode === "day-of-week") {
          // e.g. "second Tuesday". monthlyWeekNum 1-5, where 5 means "last".
          const dow = recurring.monthlyWeekDay ?? rangeStart.day();
          if (cursor.day() === dow) {
            const nth = Math.floor((cursor.date() - 1) / 7) + 1;
            const isLastOfMonth = cursor.add(7, "day").month() !== cursor.month();
            matches = recurring.monthlyWeekNum === 5 ? isLastOfMonth : nth === recurring.monthlyWeekNum;
          }
        } else {
          // Day-of-month, clamped: a schedule starting on the 31st still fires
          // on the last day of shorter months instead of skipping them.
          const targetDay = Math.min(rangeStart.date(), cursor.daysInMonth());
          matches = cursor.date() === targetDay;
        }
      }
    }

    if (matches) dates.push(cursor.toDate());
    cursor = cursor.add(1, "day");
  }

  return dates;
}

export async function generateOccurrences(
  recurring: HydratedDocument<RecurringJobType>,
  requestedUntil: Date
) {
  if (!recurring.active) return [];

  // Monthly occurrences are sparse — a ~30 day window would often catch
  // zero or one. Guarantee a year's horizon for monthly schedules.
  const yearOut = dayjs.utc().add(365, "day").toDate();
  const until =
    recurring.frequency === "monthly" && dayjs.utc(yearOut).isAfter(requestedUntil)
      ? yearOut
      : requestedUntil;

  const generateFrom = recurring.generatedUntil
    ? dayjs.utc(recurring.generatedUntil).add(1, "day").toDate()
    : recurring.startDate;

  if (dayjs.utc(generateFrom).isAfter(dayjs.utc(until), "day")) return [];

  // Atomically claim this window before doing any work, so a creation request
  // racing the cron tick can't both generate the same range.
  const claim = await recurringJobModel.updateOne(
    { _id: recurring._id, generatedUntil: recurring.generatedUntil ?? null },
    { generatedUntil: toUtcDay(until) }
  );
  if (claim.matchedCount === 0) return [];

  const template = await jobModel.findById(recurring.templateJob).lean();
  if (!template) throw new Error("Template job not found for recurring schedule");

  const occurrenceDates = getOccurrenceDates(recurring, generateFrom, until);
  if (!occurrenceDates.length) return [];

  // Both sides of this comparison go through toUtcDayKey, so the strings
  // match by construction regardless of server timezone.
  const existing = await jobModel
    .find({
      recurringJob: recurring._id,
      date: { $gte: toUtcDay(generateFrom), $lte: toUtcDay(until) },
    })
    .distinct("date");
  const existingDateKeys = new Set(existing.map(d => toUtcDayKey(d)));

  const toCreate = occurrenceDates
    .filter(d => !existingDateKeys.has(toUtcDayKey(d)))
    .map(date => ({
      title: template.title,
      description: template.description,
      company: template.company,
      client: template.client,
      location: template.location,
      address: template.address,
      ...(template.coordinates ? { coordinates: template.coordinates } : {}),
      date: toUtcDay(date),
      startTime: template.startTime,
      endTime: template.endTime,
      minutes: template.minutes,
      status: "published",
      priority: template.priority,
      requiredWorkers: template.requiredWorkers,
      supervisor: template.supervisor,
      payRate: template.payRate,
      chargeRate: template.chargeRate,
      notes: template.notes,
      instructions: template.instructions,
      recurringJob: recurring._id,
      isTemplate: false,
      createdBy: recurring.createdBy,
    }));

  if (!toCreate.length) return [];

  // ordered:false so a single duplicate-key rejection from the unique index
  // doesn't abort the rest of the batch.
  let created: any[] = [];
  try {
    created = await jobModel.insertMany(toCreate, { ordered: false });
  } catch (err: any) {
    if (err?.code === 11000 || err?.writeErrors) {
      created = err.insertedDocs ?? [];
    } else {
      throw err;
    }
  }

  if (created.length) {
    await recurringJobModel.updateOne(
      { _id: recurring._id },
      { $inc: { occurrencesGenerated: created.length } }
    );
  }

  return created;
}