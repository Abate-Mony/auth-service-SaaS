const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "../src/utils/pay.ts"), "utf8");
const { outputText } = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const mod = { exports: {} };
vm.runInNewContext(outputText, { module: mod, exports: mod.exports, require });
const P = mod.exports;

// 1h30 scheduled job, worked 2h22 → 52 minutes recorded overtime.
const base = { actualMinutes: 142, overtimeMinutes: 52, payRate: 13 };

test("adjust: cut down to 2h pays 30 minutes of overtime, not 52", () => {
  const a = { ...base, overtimeStatus: "approved", payableMinutes: 120 };
  assert.equal(P.approvedOvertimeMinutesOf(a), 30);
  const s = P.splitAssignmentPay(a, 1.5);
  assert.equal(s.regularMinutes, 90);
  assert.equal(s.overtimeMinutes, 30);
  assert.equal(s.totalPay.toFixed(2), (1.5 * 13 + 0.5 * 13 * 1.5).toFixed(2));
});

test("adjust down to the scheduled length or less → no overtime", () => {
  assert.equal(P.approvedOvertimeMinutesOf({ ...base, overtimeStatus: "approved", payableMinutes: 90 }), 0);
  assert.equal(P.approvedOvertimeMinutesOf({ ...base, overtimeStatus: "approved", payableMinutes: 60 }), 0);
});

test("approve pays all recorded overtime; adjust never exceeds it", () => {
  assert.equal(P.approvedOvertimeMinutesOf({ ...base, overtimeStatus: "approved", payableMinutes: 142 }), 52);
  assert.equal(P.approvedOvertimeMinutesOf({ ...base, overtimeStatus: "approved", payableMinutes: 200 }), 52);
});

test("rejected / pending / none → no overtime", () => {
  for (const st of ["rejected", "pending", "none", undefined]) {
    assert.equal(P.approvedOvertimeMinutesOf({ ...base, overtimeStatus: st, payableMinutes: 90 }), 0);
  }
});

test("without actualMinutes, falls back to the recorded overtime (old behaviour)", () => {
  assert.equal(P.approvedOvertimeMinutesOf({ overtimeMinutes: 52, overtimeStatus: "approved", payableMinutes: 120 }), 52);
});
