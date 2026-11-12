// node --test tests/worker-pay-rates.test.cjs
// Per-worker pay rates: payload parsing and the pay fields stored on each
// assignment (src/utils/workerPayRates.ts). Transpiles the TS source directly,
// no build or database needed.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const serverRequire = createRequire(path.join(root, "package.json"));
const ts = serverRequire("typescript");

function loadTs(relative, stubs = {}) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    const { outputText } = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    });
    const module = { exports: {} };
    const requireStub = request => {
        for (const [suffix, value] of Object.entries(stubs)) if (request.endsWith(suffix)) return value;
        throw new Error(`unexpected require: ${request}`);
    };
    vm.runInNewContext(`(function(require, module, exports) { ${outputText}\n})`, {})(requireStub, module, module.exports);
    return module.exports;
}

class BadRequestError extends Error {}
// Values built inside the vm context have that context's prototypes
const plain = v => JSON.parse(JSON.stringify(v));
const { parseCustomPayRates, assignmentPay } = loadTs("src/utils/workerPayRates.ts", {
    "/customErrors.js": { BadRequestError },
});

test("only entries with customPayRate are custom", () => {
    const rates = parseCustomPayRates([
        { email: "a@x.test" },
        { email: "b@x.test", customPayRate: 15 },
        { email: "c@x.test", customPayRate: null },
        { email: "d@x.test", customPayRate: "" },
    ]);
    assert.deepEqual(plain([...rates]), [["b@x.test", 15]]);
});

test("a stored payRate on a resent assignment is not an override", () => {
    // The edit form can resend populated assignments that carry payRate
    const rates = parseCustomPayRates([{ worker: { email: "a@x.test" }, payRate: 13 }]);
    assert.equal(rates.size, 0);
});

test("accepts nested worker email, numeric strings, and 0; rounds to pence", () => {
    const rates = parseCustomPayRates([
        { worker: { email: "a@x.test" }, customPayRate: "14.505" },
        { email: "b@x.test", customPayRate: 0 },
    ]);
    assert.equal(rates.get("a@x.test"), 14.51);
    assert.equal(rates.get("b@x.test"), 0);
});

test("rejects negative and non-numeric rates", () => {
    assert.throws(() => parseCustomPayRates([{ email: "a@x.test", customPayRate: -1 }]), BadRequestError);
    assert.throws(() => parseCustomPayRates([{ email: "a@x.test", customPayRate: "abc" }]), BadRequestError);
    assert.throws(() => parseCustomPayRates([{ email: "a@x.test", customPayRate: Infinity }]), BadRequestError);
});

test("assignmentPay uses the custom rate when given, else the default", () => {
    assert.deepEqual(plain(assignmentPay(13, undefined)), { payRate: 13, payRateIsCustom: false });
    assert.deepEqual(plain(assignmentPay(13, 15)), { payRate: 15, payRateIsCustom: true });
    assert.deepEqual(plain(assignmentPay(13, 0)), { payRate: 0, payRateIsCustom: true });
});
