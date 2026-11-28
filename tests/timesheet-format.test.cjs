const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const vm = require("node:vm");

// Load a src/utils/*.ts file (and its ./ imports) through the TS transpiler.
const load = (file) => {
  const src = fs.readFileSync(path.join(__dirname, "../src/utils", file), "utf8");
  const { outputText } = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
  const mod = { exports: {} };
  const localRequire = (id) => (id.startsWith("./") ? load(id.slice(2).replace(/\.js$/, ".ts")) : require(id));
  vm.runInNewContext(outputText, { module: mod, exports: mod.exports, require: localRequire });
  return mod.exports;
};
const F = load("timesheetFormat.ts");
const A = load("addressFormat.ts");

test("tidyAddress removes repeats but keeps everything else", () => {
  assert.equal(A.tidyAddress("15 High St, Corsham SN13 0ES, UK, Corsham, SN13 0ES"), "15 High St, Corsham SN13 0ES, UK");
  assert.equal(A.tidyAddress("Calne, UK, Calne, UK, Calne"), "Calne, UK");
  assert.equal(A.tidyAddress("10 Middle Rank, Bradford on Avon, Bradford-on-Avon BA15 1NL, UK, Bradford-on-Avon, BA15 1NL"), "10 Middle Rank, Bradford-on-Avon BA15 1NL, UK");
  // Whole words only: "Box" is a different place from "Boxford Rd".
  assert.equal(A.tidyAddress("2 Boxford Rd, Box, SN13 8AA"), "2 Boxford Rd, Box, SN13 8AA");
  // Phone numbers are the manager's data — kept in storage.
  assert.equal(A.tidyAddress("House, 07479391536, Chippenham, Wiltshire, SN14 0UG, Wiltshire"), "House, 07479391536, Chippenham, Wiltshire, SN14 0UG");
  assert.equal(A.tidyAddress(""), "");
  assert.equal(A.tidyAddress("Unit 4, Corsham Business Park"), "Unit 4, Corsham Business Park");
});

test("cleanAddress removes repeats, countries and phone numbers", () => {
  assert.equal(F.cleanAddress("Calne", "Calne, UK, Calne, UK, Calne"), "Calne");
  assert.equal(F.cleanAddress("Corsham SN13", "15 High St, Corsham SN13 0ES, UK, Corsham, SN13 0ES"), "15 High St, Corsham SN13 0ES");
  assert.equal(
    F.cleanAddress("Bradford-on-Avon BA15", "10 Middle Rank, Bradford on Avon, Bradford-on-Avon BA15 1NL, UK, Bradford-on-Avon, BA15 1NL"),
    "10 Middle Rank, Bradford-on-Avon BA15 1NL"
  );
  assert.equal(
    F.cleanAddress("2 Tiddly Wink, Yatton Keynell, Chippenham SN14 7BY, UK", "2 Tiddly Wink, Yatton Keynell, Chippenham SN14 7BY, UK, Chippenham, SN14 7BY"),
    "2 Tiddly Wink, Yatton Keynell, Chippenham SN14 7BY"
  );
  assert.equal(F.cleanAddress("House, 07479391536, Chippenham, Wiltshire, SN14 0UG, Wiltshire"), "House, Chippenham, Wiltshire, SN14 0UG");
  assert.equal(F.cleanAddress("Box, Box, UK, Box"), "Box");
  assert.equal(F.cleanAddress(null, "", "—"), "");
});

test("cleanJobTitle drops (Copy)", () => {
  assert.equal(F.cleanJobTitle("Juno Manor Farm House Deep Clean (Copy)"), "Juno Manor Farm House Deep Clean");
  assert.equal(F.cleanJobTitle("Deep clean (copy) (Copy)"), "Deep clean");
  assert.equal(F.cleanJobTitle("Copy shop clean"), "Copy shop clean");
});

test("weekStartOf gives the Monday", () => {
  assert.equal(F.weekStartOf("2026-11-04"), "2026-11-02");
  assert.equal(F.weekStartOf("2026-11-02"), "2026-11-02");
  assert.equal(F.weekStartOf("2026-11-29"), "2026-11-23");
  assert.equal(F.weekStartOf("2026-11-01"), "2026-10-26");
});

test("describeRates", () => {
  assert.equal(F.describeRates([13, 13, 13], "£"), "£13.00/h");
  assert.equal(F.describeRates([14.5, 12, 13], "£"), "£12.00–£14.50/h");
  assert.equal(F.describeRates([0, null], "£"), null);
});
