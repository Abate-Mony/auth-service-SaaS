// Shared by every place a job becomes available to self-claim — created
// that way, edited to open it up, or released back to the pool by another
// worker (createJob/updateJob in jobController.ts, the "release" case in
// workerController.ts) — so the recipient list and send logic can't drift
// between those call sites.
import userModel from "../models/userModel.js";
import JobAssignment from "../models/JobAssignment.js";
import { sendOpenShiftAvailable } from "./mailTemplates.js";
import { sendPushToUser } from "./webPush.js";
import { sendExpoPushToUser } from "./expoPush.js";
import dayjs from "./dayjsSetup.js";
import { TZ } from "./dates.js";

interface OpenShiftJobForNotify {
    _id: unknown;
    title: string;
    location?: string;
    date: Date | string;
    startTime: string;
    endTime: string;
    payRate?: number;
    company: unknown;
}

export async function notifyEligibleWorkersOfOpenShift(job: OpenShiftJobForNotify) {
    const jobId = job._id;

    // Anyone already on this job (any status) has already seen it, and
    // re-notifying a worker who just declined/cancelled it themselves would
    // be a strange experience — same "any status" exclusion getOpenShifts
    // and claimOpenShift already use.
    const existingAssignments = await JobAssignment.find({ job: jobId, isDeleted: false }).select("worker").lean();
    const excludedWorkerIds = existingAssignments.map(a => a.worker.toString());

    const eligibleWorkers = await userModel
        .find({
            company: job.company,
            role: "worker",
            isActive: true,
            _id: { $nin: excludedWorkerIds },
        })
        .select("_id fullname email");

    if (!eligibleWorkers.length) return;

    const jobForEmail = {
        _id: String(jobId),
        title: job.title,
        location: job.location,
        date: job.date,
        startTime: job.startTime,
        endTime: job.endTime,
        payRate: job.payRate,
    };
    const dateLabel = dayjs(job.date).tz(TZ).format("ddd D MMM");

    await Promise.allSettled(
        eligibleWorkers.map(worker =>
            Promise.all([
                sendOpenShiftAvailable({
                    email: worker.email,
                    fullname: worker.fullname,
                    job: jobForEmail,
                    company: job.company as any,
                }),
                sendPushToUser(worker._id.toString(), {
                    title: "Open shift available",
                    body: `${job.title} — ${dateLabel}, ${job.startTime} at ${job.location ?? "your usual site"}`,
                    tag: `open-shift-${jobId}`,
                    url: "/worker/jobs/open-shifts",
                }),
                sendExpoPushToUser(worker._id.toString(), {
                    title: "Open shift available",
                    body: `${job.title} — ${dateLabel}, ${job.startTime} at ${job.location ?? "your usual site"}`,
                    tag: `open-shift-${jobId}`,
                    url: "/worker/jobs/open-shifts",
                }),
            ])
        )
    );
}
