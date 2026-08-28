import { JobStatusNotificationType } from "./types.js";

export interface WorkerJobEmailParams {
  type: JobStatusNotificationType;

  adminEmail: string;

  worker: {
    fullname: string;
  };

  job: {
    _id: string;
    title: string;
    date: Date | string;
    startTime: string;
    endTime: string;
    location?: string;
  };

  reason?: string;
  minutesLate?: number;
  distanceMeters?: number;
}