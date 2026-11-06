// node --test tests/auto-close-assignment.test.cjs
// Exercises the production closeAssignmentAutomatically helper and
// computeWorkedMinutes against an in-memory JobAssignment/Job double that
// implements the exact findOneAndUpdate filter shapes the real code uses
// (the lease claim's $or staleness check, and the commit's autoCloseLeaseId
// equality). No DB, mail service, or application bootstrap is loaded.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { test } = require("node:test");

const serverRoot = process.env.SERVER_ROOT || path.resolve(__dirname, "..");
const sourceRoot = process.env.AUTO_CLOSE_SOURCE || serverRoot;
const serverRequire = createRequire(path.join(serverRoot, "package.json"));
const ts = serverRequire("typescript");
const mongoose = serverRequire("mongoose");

const AUTO_CLOSE_LEASE_MS = 5 * 60_000;

// Matches the real code's filter shapes only: _id, status, checkedOutAt,
// autoCloseLeaseId equality, and the lease's $or (null or stale $lte).
function matches(record, query) {
    return Object.entries(query).every(([key, expected]) => {
        if (key === "$or") return expected.some(clause => matches(record, clause));
        const actual = record[key];
        if (expected && typeof expected === "object" && !(expected instanceof Date)) {
            if ("$lte" in expected) return actual != null && new Date(actual).getTime() <= expected.$lte.getTime();
            if ("$ne" in expected) return actual !== expected.$ne;
        }
        if (expected === null) return actual === null || actual === undefined;
        return String(actual) === String(expected);
    });
}

function harness() {
    const calls = { activity: [], maybeCompleteJob: [], findOneAndUpdate: 0 };
    let assignments = [];
    let jobs = [];
    // When set, the NEXT findOneAndUpdate whose update tries to set
    // status: "completed" (i.e. the commit step, not the claim step) has
    // the matching record's lease token tampered with immediately before
    // the filter is evaluated — simulating a second process's claim call
    // landing in the real window between this process's own claim and
    // commit. Exactly the race the lease token exists to close.
    let simulateRaceOnCommit = false;

    const JobAssignmentModel = {
        findOneAndUpdate(filter, update, _opts) {
            return (async () => {
                calls.findOneAndUpdate++;
                const record = assignments.find(a => matches(a, filter));
                const isCommitStep = update.$set && update.$set.status === "completed";
                if (isCommitStep && simulateRaceOnCommit) {
                    simulateRaceOnCommit = false;
                    if (record) record.autoCloseLeaseId = "another-process-already-reclaimed-this";
                }
                const stillMatches = record && matches(record, filter);
                if (!stillMatches) return null;
                Object.assign(record, update.$set);
                return record;
            })();
        },
        updateOne(filter, update) {
            return (async () => {
                const record = assignments.find(a => matches(a, filter));
                if (record) Object.assign(record, update.$set);
                return { modifiedCount: record ? 1 : 0 };
            })();
        },
    };
    const JobModel = {
        findById(id) {
            const record = jobs.find(j => String(j._id) === String(id));
            return { lean: async () => record ?? null };
        },
    };
    const selectNull = { select: () => Promise.resolve(null) };
    const UserModel = { findOne: () => selectNull, findById: () => selectNull };

    const cache = new Map();
    function load(relative) {
        const filename = path.join(sourceRoot, relative);
        if (cache.has(filename)) return cache.get(filename).exports;
        const exports = {};
        const module = { exports };
        cache.set(filename, module);
        const source = fs.readFileSync(filename, "utf8");
        const { outputText } = ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
        });
        const requireStub = request => {
            if (request === "mongoose") return mongoose;
            // Default-imported in the production source (import X from ...) —
            // ts's __importDefault helper wraps a plain object as { default }
            // only when it lacks __esModule, so the stub must be the bare
            // model object, not pre-wrapped, or it double-wraps.
            if (request.endsWith("/JobAssignment.js")) return JobAssignmentModel;
            if (request.endsWith("/jobModel.js")) return JobModel;
            if (request.endsWith("/userModel.js")) return UserModel;
            if (request.endsWith("/computeWorkedMinutes.js")) {
                return load(path.relative(sourceRoot, path.resolve(path.dirname(filename), request.replace(/\.js$/, ".ts"))));
            }
            if (request.endsWith("/logActivity.js")) {
                return { logActivity: async params => { calls.activity.push(params); } };
            }
            if (request.endsWith("/maybeCompleteJob.js")) {
                return { maybeCompleteJob: async jobId => { calls.maybeCompleteJob.push(jobId); } };
            }
            if (request.endsWith("/notifyUser.js")) return { notifyUser: async () => {} };
            if (request.endsWith("/webPush.js")) return { sendPushToUser: async () => {} };
            if (request.endsWith("/expoPush.js")) return { sendExpoPushToUser: async () => {} };
            if (request.endsWith("/notificationPreferenceService.js")) return { shouldNotify: async () => false };
            if (request.endsWith("/sendMailsUtils.js")) return { sendWorkerJobStatusEmail: async () => {} };
            return {};
        };
        const execute = vm.runInNewContext(`(function(require, module, exports) { ${outputText}\n})`, { console }, { filename });
        execute(requireStub, module, exports);
        return module.exports;
    }

    const closeAssignmentAutomatically = load("src/utils/closeAssignmentAutomatically.ts");
    const computeWorkedMinutes = load("src/utils/computeWorkedMinutes.ts");

    return {
        calls, closeAssignmentAutomatically, computeWorkedMinutes,
        setAssignments(value) { assignments = value; },
        setJobs(value) { jobs = value; },
        getAssignment(id) { return assignments.find(a => String(a._id) === String(id)); },
        armRaceOnCommit() { simulateRaceOnCommit = true; },
    };
}

function baseAssignment(overrides = {}) {
    return {
        _id: "assignment-1", job: "job-1", worker: "worker-1", company: "company-1",
        status: "in-progress", checkedInAt: new Date("2026-11-01T12:36:00.000Z"),
        checkedOutAt: null, breaks: [], autoCloseLeaseAt: null, autoCloseLeaseId: null,
        ...overrides,
    };
}

function baseJob(overrides = {}) {
    return { _id: "job-1", title: "Test Job", date: new Date("2026-11-01"), startTime: "10:00", endTime: "13:00", minutes: 180, createdBy: "manager-1", ...overrides };
}

test("computeWorkedMinutes: an open break is never fabricated an end time or subtracted as unpaid", () => {
    const h = harness();
    const checkedInAt = new Date("2026-11-01T10:00:00.000Z");
    const checkedOutAt = new Date("2026-11-01T15:00:00.000Z"); // 5h gross
    const breaks = [{ startedAt: new Date("2026-11-01T13:00:00.000Z"), endedAt: null }];
    const result = h.computeWorkedMinutes.computeWorkedMinutes(checkedInAt, checkedOutAt, breaks, 180);
    assert.equal(result.hadOpenBreak, true);
    // Full 5h (300min) counted as worked — the ambiguous open-break span was
    // NOT subtracted, so it isn't silently discarded as unpaid.
    assert.equal(result.actualMinutes, 300);
    assert.equal(result.overtimeMinutes, 120);
    assert.equal(result.approvedMinutes, 180); // capped at job.minutes, overtime routed to review
});

test("computeWorkedMinutes: a closed break is correctly subtracted", () => {
    const h = harness();
    const checkedInAt = new Date("2026-11-01T10:00:00.000Z");
    const checkedOutAt = new Date("2026-11-01T13:30:00.000Z"); // 3h30 gross
    const breaks = [{ startedAt: new Date("2026-11-01T12:00:00.000Z"), endedAt: new Date("2026-11-01T12:30:00.000Z") }]; // 30min
    const result = h.computeWorkedMinutes.computeWorkedMinutes(checkedInAt, checkedOutAt, breaks, 180);
    assert.equal(result.hadOpenBreak, false);
    assert.equal(result.actualMinutes, 180); // 210 - 30
    assert.equal(result.overtimeMinutes, 0);
    assert.equal(result.approvedMinutes, 180);
});

test("closeAssignmentAutomatically: closes cleanly and caps approved minutes at job.minutes", async () => {
    const h = harness();
    h.setAssignments([baseAssignment()]);
    h.setJobs([baseJob()]);
    const effectiveClockOutAt = new Date("2026-11-01T17:36:00.000Z"); // checkedInAt 12:36 + 3h job + 2h buffer
    const detectedAt = new Date("2026-11-01T17:36:05.000Z");

    const result = await h.closeAssignmentAutomatically.closeAssignmentAutomatically(
        "assignment-1", effectiveClockOutAt, { trigger: "cron", detectedAt }
    );

    assert.equal(result.closed, true);
    const a = h.getAssignment("assignment-1");
    assert.equal(a.status, "completed");
    assert.equal(a.clockOutReason, "auto_closed");
    assert.equal(a.overtimeStatus, "pending");
    assert.equal(a.autoCompleted, true);
    assert.equal(a.checkedOutAt.getTime(), effectiveClockOutAt.getTime());
    assert.equal(a.actualMinutes, 300); // 12:36 -> 17:36 = 5h
    assert.equal(a.overtimeMinutes, 120);
    assert.equal(a.approvedMinutes, 180);
    // Lease fully released by the successful commit's own fields — the
    // assignment is no longer "in-progress" at all, so lease fields are moot,
    // but the activity log must still have fired with both timestamps.
    assert.equal(h.calls.activity.length, 1);
    assert.equal(h.calls.activity[0].metadata.detectedAt.getTime(), detectedAt.getTime());
    assert.equal(h.calls.activity[0].metadata.provisionalClockOutAt.getTime(), effectiveClockOutAt.getTime());
});

test("closeAssignmentAutomatically: rejects a clock-out before the check-in and releases the lease", async () => {
    const h = harness();
    h.setAssignments([baseAssignment()]);
    h.setJobs([baseJob()]);
    const invalidClockOutAt = new Date("2026-11-01T11:00:00.000Z"); // before checkedInAt 12:36

    const result = await h.closeAssignmentAutomatically.closeAssignmentAutomatically(
        "assignment-1", invalidClockOutAt, { trigger: "back_to_back_clock_in", detectedAt: new Date() }
    );

    assert.equal(result.closed, false);
    assert.equal(result.reason, "invalid_clock_out_time");
    const a = h.getAssignment("assignment-1");
    assert.equal(a.status, "in-progress"); // untouched
    assert.equal(a.autoCloseLeaseAt, null); // lease released, not left stranded
    assert.equal(a.autoCloseLeaseId, null);
});

test("closeAssignmentAutomatically: a stale lease from a crashed process is reclaimable, not permanently stuck", async () => {
    const h = harness();
    h.setAssignments([baseAssignment({
        autoCloseLeaseAt: new Date(Date.now() - AUTO_CLOSE_LEASE_MS - 1000), // older than the lease window
        autoCloseLeaseId: "dead-process-token",
    })]);
    h.setJobs([baseJob()]);

    const result = await h.closeAssignmentAutomatically.closeAssignmentAutomatically(
        "assignment-1", new Date("2026-11-01T17:36:00.000Z"), { trigger: "cron", detectedAt: new Date() }
    );

    assert.equal(result.closed, true);
    assert.equal(h.getAssignment("assignment-1").status, "completed");
});

test("closeAssignmentAutomatically: a fresh lease (not yet stale) cannot be claimed by a second attempt", async () => {
    const h = harness();
    h.setAssignments([baseAssignment({
        autoCloseLeaseAt: new Date(), // claimed just now — well within the lease window
        autoCloseLeaseId: "other-process-token",
    })]);
    h.setJobs([baseJob()]);

    const result = await h.closeAssignmentAutomatically.closeAssignmentAutomatically(
        "assignment-1", new Date("2026-11-01T17:36:00.000Z"), { trigger: "cron", detectedAt: new Date() }
    );

    assert.equal(result.closed, false);
    assert.equal(result.reason, "not_claimable");
    assert.equal(h.getAssignment("assignment-1").status, "in-progress"); // untouched
});

test("closeAssignmentAutomatically: losing the lease between claim and commit surfaces as lease_lost, not a false close", async () => {
    const h = harness();
    h.setAssignments([baseAssignment()]);
    h.setJobs([baseJob()]);

    // Right before the commit step's findOneAndUpdate evaluates its filter,
    // the harness tampers with the record's autoCloseLeaseId — simulating a
    // second process's claim landing in the real window between this
    // process's own claim and commit. This is the exact race the lease
    // token exists to close: the commit is conditioned on owning that
    // token, so it must fail here rather than succeed on stale ownership.
    h.armRaceOnCommit();

    const result = await h.closeAssignmentAutomatically.closeAssignmentAutomatically(
        "assignment-1", new Date("2026-11-01T17:36:00.000Z"), { trigger: "cron", detectedAt: new Date() }
    );

    assert.equal(result.closed, false);
    assert.equal(result.reason, "lease_lost");
    // The record must NOT have been closed by the losing process — it's
    // left exactly as the (simulated) winning process's reclaim left it.
    const a = h.getAssignment("assignment-1");
    assert.equal(a.status, "in-progress");
    assert.equal(a.checkedOutAt, null);
    // No side effects (activity log, notifications) fired for the loser.
    assert.equal(h.calls.activity.length, 0);
});
