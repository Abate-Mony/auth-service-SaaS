import { NOTIFICATION_CHANNELS, NOTIFICATION_EVENTS } from "./constant.js";

export type USER_ROLES  = 'admin' | 'user'|"moderator" | "worker" | "manager";
export type JobStatusNotificationType =
  | "accept-job"
  | "reject-job"
  | "start-job"
  | "late-start"
  | "geofence-warning"
  | "complete-job"
  | "overtime-review";
  

  export type NotificationEvent =
    (typeof NOTIFICATION_EVENTS)[number];


export type NotificationChannel =
    (typeof NOTIFICATION_CHANNELS)[number];


