// controllers/notificationPreferenceController.ts

import { StatusCodes } from "http-status-codes";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { NOTIFICATION_CHANNELS, NOTIFICATION_EVENTS } from "../utils/constant.js";
import { NotificationChannel, NotificationEvent } from "../utils/types.js";
import NotificationPreferenceModel from "../models/NotificationPreferenceModel.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import recurringJobModel from "../models/recurringJobModel.js";
import jobModel from "../models/jobModel.js";
import { toUtcDay } from "../utils/dates.js";
import JobAssignment from "../models/JobAssignment.js";

export const getMyNotificationPreferences: MiddlewareFn = async (
    req,
    res
) => {
    const userId = req.user.user_id;

    const preferences = await NotificationPreferenceModel.findOne({
        user: userId,
    }).lean();

    if (!preferences) {
        throw new NotFoundError(
            "Notification preferences not found."
        );
    }

    res.status(StatusCodes.OK).json({
        success: true,
        preferences,
    });
};


export const updateMyNotificationPreferences: MiddlewareFn = async (
    req,
    res
) => {
    const userId = req.user.user_id;

    const {
        emailEnabled,
        pushEnabled,
        inAppEnabled,
        events,
    } = req.body;

    const update: Record<string, boolean> = {};

    // ─────────────────────────────────────
    // Master channel switches
    // ─────────────────────────────────────

    if (typeof emailEnabled === "boolean") {
        update.emailEnabled = emailEnabled;
    }

    if (typeof pushEnabled === "boolean") {
        update.pushEnabled = pushEnabled;
    }

    if (typeof inAppEnabled === "boolean") {
        update.inAppEnabled = inAppEnabled;
    }


    // ─────────────────────────────────────
    // Individual event preferences
    // ─────────────────────────────────────

    if (events !== undefined) {
        if (
            typeof events !== "object" ||
            events === null ||
            Array.isArray(events)
        ) {
            throw new BadRequestError(
                "Events must be an object."
            );
        }

        for (const [event, channels] of Object.entries(events)) {

            // Don't allow arbitrary MongoDB paths
            if (
                !NOTIFICATION_EVENTS.includes(
                    event as NotificationEvent
                )
            ) {
                throw new BadRequestError(
                    `Invalid notification event: ${event}`
                );
            }

            if (
                typeof channels !== "object" ||
                channels === null ||
                Array.isArray(channels)
            ) {
                throw new BadRequestError(
                    `Invalid preferences for ${event}.`
                );
            }

            for (
                const [channel, enabled]
                of Object.entries(channels)
            ) {

                if (
                    !NOTIFICATION_CHANNELS.includes(
                        channel as NotificationChannel
                    )
                ) {
                    throw new BadRequestError(
                        `Invalid notification channel: ${channel}`
                    );
                }

                if (typeof enabled !== "boolean") {
                    throw new BadRequestError(
                        `${event}.${channel} must be true or false.`
                    );
                }

                update[
                    `events.${event}.${channel}`
                ] = enabled;
            }
        }
    }


    if (Object.keys(update).length === 0) {
        throw new BadRequestError(
            "No notification preferences provided."
        );
    }


    const preferences =
        await NotificationPreferenceModel.findOneAndUpdate(
            {
                user: userId,
            },
            {
                $set: update,
            },
            {
                new: true,
                runValidators: true,
            }
        );


    if (!preferences) {
        throw new NotFoundError(
            "Notification preferences not found."
        );
    }


    res.status(StatusCodes.OK).json({
        success: true,
        message: "Notification preferences updated.",
        preferences,
    });
};

export const cancelRecurringSeries: MiddlewareFn = async (req, res) => {
  const { id } = req.params;
  const { scope } = req.body; // "stop" | "stop-and-cancel" | "this-only"

  const recurring = await recurringJobModel.findById(id);
  if (!recurring) throw new NotFoundError("Schedule not found");

  if (scope !== "this-only") {
    recurring.active = false;
    await recurring.save();
  }

  if (scope === "stop-and-cancel") {
    const futureJobs = await jobModel.find({
      recurringJob: id,
      date: { $gte: toUtcDay(new Date()) },
      status: { $nin: ["completed", "cancelled"] },
    }).distinct("_id");

    await jobModel.updateMany({ _id: { $in: futureJobs } }, { status: "cancelled" });
    await JobAssignment.updateMany(
      { job: { $in: futureJobs }, status: { $in: ["pending", "accepted"] } },
      { status: "cancelled", cancellationReason: "Recurring shift cancelled" }
    );
    // Workers who'd accepted need telling
  }

  res.status(StatusCodes.OK).json({ success: true });
};