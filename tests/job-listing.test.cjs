const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "../src/utils/jobListing.ts"), "utf8");
const { outputText } = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const mod = { exports: {} };
vm.runInNewContext(outputText, { module: mod, exports: mod.exports, require });
const L = mod.exports;
const plain = v => JSON.parse(JSON.stringify(v));

const today = new Date("2026-11-19T00:00:00.000Z");
const job = (o = {}) => ({ status: "published", date: today, startTime: "09:00", endTime: "12:00", minutes: 180, ...o });

test("staffing counts confirmed, invited and open places", () => {
  assert.deepEqual(plain(L.staffingFor(3, ["accepted", "pending", "declined"])), { required: 3, filled: 1, pending: 1, open: 1 });
  assert.deepEqual(plain(L.staffingFor(1, ["in-progress"])), { required: 1, filled: 1, pending: 0, open: 0 });
  assert.deepEqual(plain(L.staffingFor(undefined, [])), { required: 1, filled: 0, pending: 0, open: 1 });
  assert.equal(L.staffingFor(1, ["accepted", "accepted"]).open, 0, "over-staffed never goes negative");
});

test("attention: unfilled, broken time, draft starting soon", () => {
  const open = L.staffingFor(2, ["accepted"]);
  const full = L.staffingFor(1, ["accepted"]);
  assert.deepEqual(plain(L.attentionReasons(job(), open, today)), ["unfilled"]);
  assert.deepEqual(plain(L.attentionReasons(job({ startTime: "13:00", endTime: "13:00", minutes: 0 }), full, today)), ["time"]);
  assert.deepEqual(plain(L.attentionReasons(job({ status: "draft", date: new Date("2026-11-21T00:00:00Z") }), full, today)), ["draft_soon"]);
  assert.deepEqual(plain(L.attentionReasons(job({ status: "draft", date: new Date("2026-11-25T00:00:00Z") }), full, today)), []);
});

test("attention ignores past, completed and cancelled jobs", () => {
  const open = L.staffingFor(2, []);
  assert.deepEqual(plain(L.attentionReasons(job({ date: new Date("2026-11-18T00:00:00Z") }), open, today)), []);
  assert.deepEqual(plain(L.attentionReasons(job({ status: "completed" }), open, today)), []);
  assert.deepEqual(plain(L.attentionReasons(job({ status: "cancelled" }), open, today)), []);
});

test("booking positions number each group's days in date order", () => {
  const p = L.bookingPositions([
    { _id: "c", bookingGroup: "g1", date: new Date("2026-11-22") },
    { _id: "a", bookingGroup: "g1", date: new Date("2026-11-20") },
    { _id: "b", bookingGroup: "g1", date: new Date("2026-11-21") },
    { _id: "x", bookingGroup: "g2", date: new Date("2026-11-20") },
  ]);
  assert.deepEqual(plain(p.get("a")), { day: 1, of: 3 });
  assert.deepEqual(plain(p.get("c")), { day: 3, of: 3 });
  assert.deepEqual(plain(p.get("x")), { day: 1, of: 1 });
});

test("repeat labels", () => {
  assert.equal(L.describeRepeat("weekly", 1), "Repeats weekly");
  assert.equal(L.describeRepeat("weekly", 2), "Repeats every 2 weeks");
  assert.equal(L.describeRepeat("daily", undefined), "Repeats daily");
  assert.equal(L.describeRepeat(undefined, 1), null);
});

test("csv quotes and neutralises formulas", () => {
  assert.equal(L.toCsv([["a,b", 'say "hi"', 3, null]]), '"a,b","say ""hi""",3,\r\n');
  assert.equal(L.toCsv([["=SUM(A1)", "@x"]]), "'=SUM(A1),'@x\r\n");
});

test("escapeRegExp makes search text literal", () => {
  assert.ok(new RegExp(L.escapeRegExp("a.b(c)")).test("xa.b(c)y"));
  assert.ok(!new RegExp(L.escapeRegExp("a.b")).test("axb"));
});
