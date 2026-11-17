// node --test tests/multi-day-schedule.test.cjs
// "Several days" bookings: schedule payload validation (src/utils/multiDaySchedule.ts).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const ts = createRequire(path.join(root, "package.json"))("typescript");

function loadTs(relative, stubs) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    const { outputText } = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    });
    const module = { exports: {} };
    const req = r => { for (const [k, v] of Object.entries(stubs)) if (r.endsWith(k)) return v; throw new Error(`unexpected require: ${r}`); };
    vm.runInNewContext(`(function(require, module, exports) { ${outputText}\n})`, { Date, JSON, Number, Set })(req, module, module.exports);
    return module.exports;
}

class BadRequestError extends Error {}
const toUtcDay = d => { const x = new Date(typeof d === "string" && d.length === 10 ? `${d}T00:00:00.000Z` : d); return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate())); };
const { parseSchedule, describeDays, MAX_SCHEDULE_DAYS } = loadTs("src/utils/multiDaySchedule.ts", {
    "/customErrors.js": { BadRequestError },
    "/dates.js": { toUtcDay },
});
const today = new Date("2026-11-17T09:00:00Z");
const day = (date, startTime = "09:00", endTime = "13:00") => ({ date, startTime, endTime });

test("no schedule → null (normal single-day job)", () => {
    assert.equal(parseSchedule(undefined, today), null);
    assert.equal(parseSchedule("", today), null);
});

test("sorts days, keeps per-day times, accepts a JSON string", () => {
    const out = parseSchedule(JSON.stringify([day("2026-11-27", "14:00", "18:00"), day("2026-11-23")]), today);
    assert.deepEqual(out.map(d => [d.date.toISOString().slice(0, 10), d.startTime, d.endTime]), [
        ["2026-11-23", "09:00", "13:00"],
        ["2026-11-27", "14:00", "18:00"],
    ]);
});

test("today is allowed; past days, duplicates and bad times are refused", () => {
    assert.equal(parseSchedule([day("2026-11-17")], today).length, 1);
    assert.throws(() => parseSchedule([day("2026-11-16")], today), /in the past/);
    assert.throws(() => parseSchedule([day("2026-11-23"), day("2026-11-23")], today), /listed twice/);
    assert.throws(() => parseSchedule([day("2026-11-23", "9am", "13:00")], today), /HH:mm/);
    assert.throws(() => parseSchedule([day("2026-11-23", "09:00", "09:00")], today), /same/);
    assert.throws(() => parseSchedule([{ date: "23/11/2026", startTime: "09:00", endTime: "10:00" }], today), /invalid date/);
    assert.throws(() => parseSchedule([], today), /at least one/);
    assert.throws(() => parseSchedule("{nope", today), BadRequestError);
});

test("overnight shifts (finish before start) are allowed", () => {
    assert.equal(parseSchedule([day("2026-11-23", "22:00", "06:00")], today)[0].endTime, "06:00");
});

test("caps the number of days", () => {
    const many = Array.from({ length: MAX_SCHEDULE_DAYS + 1 }, (_, i) => day(new Date(Date.UTC(2026, 10, 18 + i)).toISOString().slice(0, 10)));
    assert.throws(() => parseSchedule(many, today), /at most/);
});

test("describeDays groups by month and trims long lists", () => {
    const pad = n => String(n).padStart(2, "0");
    const fmt = (d, p) => {
        const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
        const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()];
        return p === "MM" ? pad(d.getUTCMonth() + 1) : p === "ddd D" ? `${dow} ${d.getUTCDate()}` : `${dow} ${d.getUTCDate()} ${mon}`;
    };
    const d = s => new Date(`${s}T00:00:00Z`);
    assert.equal(describeDays([d("2026-11-23"), d("2026-11-25"), d("2026-11-27")], fmt), "Mon 23, Wed 25, Fri 27 Nov");
    assert.equal(describeDays([d("2026-11-30"), d("2026-12-01")], fmt), "Mon 30 Nov, Tue 1 Dec");
    const seven = ["23","24","25","26","27","28","29"].map(x => d(`2026-11-${x}`));
    assert.match(describeDays(seven, fmt), /and 2 more$/);
});
