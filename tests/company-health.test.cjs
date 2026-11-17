// node --test tests/company-health.test.cjs
// Platform company health rules (src/utils/companyHealth.ts).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const ts = createRequire(path.join(root, "package.json"))("typescript");
const source = fs.readFileSync(path.join(root, "src/utils/companyHealth.ts"), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } });
const mod = { exports: {} };
vm.runInNewContext(`(function(module, exports) { ${outputText}\n})`, { Date, Math })(mod, mod.exports);
const { assessHealth } = mod.exports;

const now = new Date("2026-11-17T12:00:00Z");
const daysAgo = n => new Date(now.getTime() - n * 864e5);
const base = {
  createdAt: daysAgo(60),
  lastManagerLoginAt: daysAgo(1),
  jobsLast30Days: 12,
  activeWorkers: 5,
  subscriptionStatus: "active",
  onboarding: { firstJob: true, workerInvited: true, firstInvoice: true },
};

test("an active, onboarded company is healthy", () => {
  const h = assessHealth(base, now);
  assert.equal(h.level, "healthy");
  assert.equal(h.score, 100);
  assert.equal(h.reasons.length, 0);
});

test("a failing payment is at risk", () => {
  const h = assessHealth({ ...base, subscriptionStatus: "past_due" }, now);
  assert.equal(h.level, "at_risk");
  assert.match(h.reasons[0], /Payment failing \(past due\)/);
});

test("no manager login for 15+ days is at risk; 8–14 days is watch", () => {
  assert.equal(assessHealth({ ...base, lastManagerLoginAt: daysAgo(20) }, now).level, "at_risk");
  assert.equal(assessHealth({ ...base, lastManagerLoginAt: daysAgo(10) }, now).level, "watch");
});

test("no jobs for 30 days is at risk once the company is over 2 weeks old", () => {
  assert.equal(assessHealth({ ...base, jobsLast30Days: 0 }, now).level, "at_risk");
  const young = { ...base, createdAt: daysAgo(5), jobsLast30Days: 0, onboarding: { firstJob: false, workerInvited: true, firstInvoice: false } };
  assert.equal(assessHealth(young, now).level, "watch"); // onboarding unfinished, not at risk yet
});

test("brand-new companies aren't flagged for onboarding or never logging in", () => {
  const fresh = { ...base, createdAt: daysAgo(1), lastManagerLoginAt: null, jobsLast30Days: 0, onboarding: { firstJob: false, workerInvited: false, firstInvoice: false } };
  assert.equal(assessHealth(fresh, now).level, "healthy");
});

test("never logged in after a week is at risk", () => {
  assert.equal(assessHealth({ ...base, lastManagerLoginAt: null }, now).level, "at_risk");
});

test("score never goes below 0", () => {
  const worst = { ...base, subscriptionStatus: "unpaid", lastManagerLoginAt: null, jobsLast30Days: 0, onboarding: { firstJob: false, workerInvited: false, firstInvoice: false } };
  const h = assessHealth(worst, now);
  assert.equal(h.level, "at_risk");
  assert.ok(h.score >= 0);
  assert.ok(h.reasons.length >= 3);
});
