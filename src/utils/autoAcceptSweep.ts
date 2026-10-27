import JobAssignment from "../models/JobAssignment.js";

// Shared by every place an auto-accept switch can be flipped ON — the
// worker-level toggle (workerController.setWorkerAutoAccept), a single
// job's own autoAccept field (jobController.updateJob), and a recurring
// schedule's pattern-level autoAccept (recurringJobController.
// updateRecurringJob) — so turning any of them on also covers whatever's
// already sitting there as "pending", not just assignments created
// afterwards. Never touches a claim still awaiting manager review
// (pendingApproval) — same precedent as the worker's own accept endpoint —
// and never un-accepts anything, since callers only ever invoke this when
// switching something ON.
export async function sweepAcceptPendingAssignments(scope: {
  jobIds?: any[];
  workerIds?: any[];
}): Promise<number> {
  const match: Record<string, any> = {
    status: "pending",
    pendingApproval: { $ne: true },
    isDeleted: false,
  };
  if (scope.jobIds) match.job = { $in: scope.jobIds };
  if (scope.workerIds) match.worker = { $in: scope.workerIds };

  const result = await JobAssignment.updateMany(match, {
    status: "accepted",
    acceptedAt: new Date(),
  });
  return result.modifiedCount;
}
