const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "../src/utils/jobTemplateFields.ts"), "utf8");
const { outputText } = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const mod = { exports: {} };
vm.runInNewContext(outputText, { module: mod, exports: mod.exports, require });
const T = mod.exports;
const plain = v => JSON.parse(JSON.stringify(v));

test("copies only the reusable parts of a job", () => {
  const out = plain(T.templateFieldsFromJob({
    title: "Deep clean", description: "Top to bottom", priority: "high", startTime: "09:00", endTime: "13:00",
    requiredWorkers: 3, payRate: 13.5, chargeType: "hourly", chargeRate: 85, chargeAmount: 40,
    instructions: "Bring steam cleaner", notes: "n", openToClaims: true, requiresApproval: false, autoAccept: true,
    checklist: [{ text: "Oven", done: true, completedBy: "u1", completedAt: "2026-01-01" }, { text: "  " }],
    client: "c1", site: "s1", date: "2026-11-01", status: "completed", invoice: "i1", workers: [{ email: "x" }],
  }));
  assert.deepEqual(out, {
    title: "Deep clean", description: "Top to bottom", priority: "high", startTime: "09:00", endTime: "13:00",
    requiredWorkers: 3, payRate: 13.5, chargeType: "hourly", chargeRate: 85, chargeAmount: 0,
    instructions: "Bring steam cleaner", notes: "n", checklist: [{ text: "Oven" }],
    openToClaims: true, requiresApproval: false, autoAccept: true,
  });
});

test("fixed price keeps the amount, drops the hourly rate; bad values get safe defaults", () => {
  const out = T.templateFieldsFromJob({ title: "Oven clean", chargeType: "fixed", chargeAmount: 65, chargeRate: 20, priority: "weird", startTime: "9am", requiredWorkers: 0 });
  assert.equal(out.chargeAmount, 65);
  assert.equal(out.chargeRate, 0);
  assert.equal(out.priority, "medium");
  assert.equal(out.startTime, "");
  assert.equal(out.requiredWorkers, 1);
  assert.equal(out.requiresApproval, true);
});

test("most used first, then most recently used, then by name", () => {
  const list = [
    { name: "B", useCount: 2, lastUsedAt: "2026-11-01" },
    { name: "A", useCount: 2, lastUsedAt: "2026-11-20" },
    { name: "Z", useCount: 9 },
    { name: "C", useCount: 0 },
    { name: "Aa", useCount: 0 },
  ];
  assert.deepEqual(list.sort(T.compareTemplates).map(t => t.name), ["Z", "A", "B", "Aa", "C"]);
});
