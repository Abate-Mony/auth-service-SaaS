// services/notificationPreferenceService.ts

import NotificationPreferenceModel from "../models/NotificationPreferenceModel.js";
import { NotificationChannel, NotificationEvent } from "../utils/types.js";


function getDefaultPreference(
  event: NotificationEvent,
  channel: NotificationChannel
): boolean {

  const defaults: Record<
    NotificationEvent,
    Record<NotificationChannel, boolean>
  > = {

    job_assigned: {
      email: true,
      push: true,
      inApp: true,
    },

    job_accepted: {
      email: false,
      push: true,
      inApp: true,
    },

    job_declined: {
      email: true,
      push: true,
      inApp: true,
    },

    worker_checked_in: {
      email: false,
      push: false,
      inApp: true,
    },

    worker_late: {
      email: true,
      push: true,
      inApp: true,
    },

    worker_checked_out: {
      email: false,
      push: false,
      inApp: true,
    },

    job_completed: {
      email: false,
      push: true,
      inApp: true,
    },

    geofence_warning: {
      email: true,
      push: true,
      inApp: true,
    },

    timesheet_submitted: {
      email: false,
      push: true,
      inApp: true,
    },

    timesheet_approved: {
      email: true,
      push: true,
      inApp: true,
    },

    timesheet_rejected: {
      email: true,
      push: true,
      inApp: true,
    },
  };

  return defaults[event][channel];
}
export async function shouldNotify(
  userId: string,
  event: NotificationEvent,
  channel: NotificationChannel
): Promise<boolean> {

  const preferences = await NotificationPreferenceModel
    .findOne({ user: userId })
    .lean();

  // No preference document yet.
  // Use system defaults.
  if (!preferences) {
    return getDefaultPreference(event, channel);
  }

  // Check master channel switch first
  if (
    channel === "email" &&
    !preferences.emailEnabled
  ) {
    return false;
  }

  if (
    channel === "push" &&
    !preferences.pushEnabled
  ) {
    return false;
  }

  if (
    channel === "inApp" &&
    !preferences.inAppEnabled
  ) {
    return false;
  }

  const eventPreferences =
    preferences.events?.[event];

  if (!eventPreferences) {
    return getDefaultPreference(event, channel);
  }

  return eventPreferences[channel] ?? false;
}