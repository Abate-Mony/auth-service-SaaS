// node --test tests/quote-expiry.test.cjs
// Executes the production controllers with in-memory model doubles. No DB,
// mail service, environment file or application bootstrap is loaded.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { test } = require("node:test");

const serverRoot = process.env.SERVER_ROOT || path.resolve(__dirname, "..");
const sourceRoot = process.env.QUOTE_EXPIRY_SOURCE || serverRoot;
const serverRequire = createRequire(path.join(serverRoot, "package.json"));
const ts = serverRequire("typescript");
const mongoose = serverRequire("mongoose");
const instant = Date.parse("2026-11-01T10:00:00.000Z");
const companyId = "111111111111111111111111";
const clientId = "222222222222222222222222";
const userId = "333333333333333333333333";

function harness() {
    let now = instant;
    const calls = { saved: 0, users: 0, clients: 0, companies: 0, emails: 0, queries: [] };
    let records = [];
    let userLookup = () => ({ fullname: "Client Name", email: "client@example.test" });
    class ClockDate extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    }
    const resultQuery = value => ({
        select() { return this; },
        lean: async () => value,
        then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
    });
    const models = {
        Quote: {
            find(query) {
                calls.queries.push(query);
                let selected = records.filter(record => matches(record, query));
                return {
                    sort(sort) {
                        const [field, direction] = Object.entries(sort)[0];
                        selected.sort((a, b) => (a[field] > b[field] ? 1 : a[field] < b[field] ? -1 : 0) * direction);
                        return this;
                    },
                    skip(skip) { selected = selected.slice(skip); return this; },
                    limit(limit) { selected = selected.slice(0, limit); return this; },
                    lean: async () => selected,
                };
            },
            countDocuments: async query => records.filter(record => matches(record, query)).length,
            findOne: async query => records.find(record => matches(record, query)),
        },
        User: { findById() { calls.users++; return resultQuery(userLookup()); } },
        Client: { findById() { calls.clients++; return resultQuery(null); } },
        Company: { findById() { calls.companies++; return resultQuery(null); } },
    };
    const cache = new Map();
    function load(relative) {
        const filename = path.join(sourceRoot, relative);
        if (cache.has(filename)) return cache.get(filename).exports;
        const exports = {};
        const module = { exports };
        cache.set(filename, module);
        const fallback = path.join(serverRoot, relative);
        const source = fs.readFileSync(fs.existsSync(filename) ? filename : fallback, "utf8");
        const { outputText } = ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
        });
        const requireStub = request => {
            if (request === "mongoose") return mongoose;
            if (request === "zod" || request === "http-status-codes") return serverRequire(request);
            if (request.includes("/models/")) {
                const names = { quoteModel: "Quote", userModel: "User", clientModel: "Client", company: "Company" };
                return models[names[path.basename(request, ".js")]] || {};
            }
            if (/\/(quoteExpiry|portalSerializers|customErrors)\.js$/.test(request) || request === "./quoteController.js") {
                const target = path.relative(sourceRoot, path.resolve(path.dirname(filename), request.replace(/\.js$/, ".ts")));
                return load(target);
            }
            if (request.endsWith("/tokenUtils.js")) return { hashQuoteResponseToken: token => `hashed:${token}` };
            if (request.endsWith("/mailTemplates.js")) {
                const send = async () => { calls.emails++; };
                return { sendQuoteResponseNotice: send, sendQuoteThankYouEmail: send };
            }
            return {};
        };
        const execute = vm.runInNewContext(`(function(require, module, exports) { ${outputText}\n})`, {
            Date: ClockDate, console,
        }, { filename });
        execute(requireStub, module, exports);
        return module.exports;
    }
    const expiry = load("src/utils/quoteExpiry.ts");
    const serializers = load("src/utils/portalSerializers.ts");
    const quote = load("src/controllers/quoteController.ts");
    const portal = load("src/controllers/portalController.ts");
    const makeQuote = (id, status = "sent", deadline = instant + 60_000, extra = {}) => ({
        _id: id, company: companyId, client: clientId, isDeleted: false,
        createdAt: new ClockDate(instant), status, validUntil: deadline == null ? undefined : new ClockDate(deadline),
        responseTokenHash: "hashed:public-token", depositPercentage: 50, createdBy: userId,
        async save() { calls.saved++; return this; },
        ...extra,
    });
    const req = (query = {}) => ({ query, user: { client_id: clientId, company_id: companyId, user_id: userId }, params: { id: "q", token: "public-token" }, body: {} });
    const response = () => ({ status() { return this; }, json(value) { this.body = value; return this; } });
    return {
        calls, expiry, serializers, quote, portal, makeQuote, req, response,
        setRecords(value) { records = value; }, setNow(value) { now = value; },
        setUserLookup(value) { userLookup = value; },
    };
}

// This evaluates only the Mongo operators produced by the real controllers.
function matches(record, query) {
    return Object.entries(query).every(([key, expected]) => {
        if (key === "$and") return expected.every(filter => matches(record, filter));
        if (key === "$or") return expected.some(filter => matches(record, filter));
        if (key === "$nor") return expected.every(filter => !matches(record, filter));
        const actual = key.split(".").reduce((value, segment) => value?.[segment], record);
        if (expected && typeof expected === "object" && !expected._bsontype && !(expected instanceof Date)) {
            if ("$in" in expected) return expected.$in.includes(actual);
            if ("$lt" in expected) return actual != null && new Date(actual).getTime() < expected.$lt.getTime();
            if ("$regex" in expected) return new RegExp(expected.$regex, expected.$options).test(actual || "");
        }
        return String(actual) === String(expected);
    });
}

test("expiry boundary, terminal states and public-link lifetime use one policy", () => {
    const h = harness();
    const now = new Date(instant);
    for (const status of ["sent", "viewed"]) {
        assert.equal(h.expiry.getEffectiveQuoteStatus(h.makeQuote("q", status, instant - 1), now), "expired");
        assert.equal(h.expiry.getEffectiveQuoteStatus(h.makeQuote("q", status, instant), now), status);
        assert.equal(h.expiry.getEffectiveQuoteStatus(h.makeQuote("q", status, instant + 1), now), status);
    }
    for (const status of ["draft", "accepted", "declined", "cancelled", "expired"]) {
        assert.equal(h.expiry.getEffectiveQuoteStatus(h.makeQuote("q", status, instant - 1), now), status);
    }
    const linked = h.makeQuote("q", "sent", instant + 1, { responseTokenExpiresAt: new Date(instant - 1) });
    assert.equal(h.expiry.getEffectiveQuoteStatus(linked, now), "sent");
    assert.equal(h.expiry.getEffectiveQuoteStatus(linked, now, { publicToken: true }), "expired");
});

test("portal status filters count effective expiry before pagination and retain tenant scope", async () => {
    const h = harness();
    h.setRecords([
        h.makeQuote("old-sent", "sent", instant - 1), h.makeQuote("old-viewed", "viewed", instant - 1),
        h.makeQuote("stored-expired", "expired"), h.makeQuote("live-sent"), h.makeQuote("live-viewed", "viewed"),
        h.makeQuote("accepted", "accepted", instant - 1), h.makeQuote("draft", "draft"), h.makeQuote("cancelled", "cancelled"),
        h.makeQuote("other-client", "sent", instant - 1, { client: "other" }),
        h.makeQuote("other-tenant", "sent", instant - 1, { company: "other" }),
        h.makeQuote("deleted", "sent", instant - 1, { isDeleted: true }),
    ]);
    const expired = h.response();
    await h.portal.getPortalQuotes(h.req({ status: "expired", page: "2", limit: "2" }), expired);
    assert.equal(expired.body.total, 3);
    assert.equal(expired.body.totalPages, 2);
    assert.equal(expired.body.currentPage, 2);
    assert.equal(expired.body.quotes.length, 1);
    assert.ok(expired.body.quotes.every(q => q.status === "expired"));
    for (const status of ["sent", "viewed"]) {
        const res = h.response();
        await h.portal.getPortalQuotes(h.req({ status, limit: "1" }), res);
        assert.equal(res.body.total, 1);
        assert.equal(res.body.quotes[0]._id, `live-${status}`);
    }
    const all = h.response();
    await h.portal.getPortalQuotes(h.req(), all);
    assert.equal(all.body.total, 6);
    assert.equal(all.body.quotes.find(q => q._id === "old-sent").status, "expired");
    assert.equal("depositPercentage" in all.body.quotes[0], false);
    assert.equal(h.calls.saved, 0);
});

test("admin expiry filtering composes with search and preserves exact counts", async () => {
    const h = harness();
    h.setRecords([
        h.makeQuote("old", "sent", instant - 1, { title: "Office" }),
        h.makeQuote("live", "sent", instant + 1, { title: "Office" }),
        h.makeQuote("not-search-match", "viewed", instant - 1, { title: "Home" }),
    ]);
    const res = h.response();
    await h.quote.getAllQuotes(h.req({ status: "expired", search: "Office" }), res);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.quotes[0]._id, "old");
    assert.equal(res.body.quotes[0].status, "expired");
});

test("portal expired details stay expired and are not marked viewed", async () => {
    const h = harness();
    const expired = h.makeQuote("q", "sent", instant - 1);
    h.setRecords([expired]);
    const res = h.response();
    await h.portal.getPortalQuote(h.req(), res);
    assert.equal(res.body.quote.status, "expired");
    assert.equal(expired.status, "sent");
    assert.equal(expired.viewedAt, undefined);
    assert.equal(h.calls.saved, 0);
});

test("valid portal details still mark viewed and return the existing whitelist", async () => {
    const h = harness();
    h.setRecords([h.makeQuote("q")]);
    const res = h.response();
    await h.portal.getPortalQuote(h.req(), res);
    assert.equal(res.body.quote.status, "viewed");
    assert.ok(res.body.quote.viewedAt);
    assert.equal(h.calls.saved, 1);
    assert.equal("responseTokenHash" in res.body.quote, false);
});

for (const action of ["accept", "decline"]) {
    test(`portal cannot ${action} expired quotes or trigger response effects`, async () => {
        const h = harness();
        h.setRecords([h.makeQuote("q", "viewed", instant - 1)]);
        const handler = action === "accept" ? h.portal.acceptPortalQuote : h.portal.declinePortalQuote;
        await assert.rejects(handler(h.req(), h.response()), error => error.code === "QUOTE_EXPIRED");
        assert.equal(h.calls.saved + h.calls.users + h.calls.clients + h.calls.companies, 0);
    });
}

test("portal rechecks a deadline crossed during the awaited user lookup", async () => {
    const h = harness();
    const quote = h.makeQuote("q", "sent", instant + 1);
    h.setRecords([quote]);
    h.setUserLookup(() => {
        h.setNow(instant + 2);
        return { fullname: "Client", email: "client@example.test" };
    });
    await assert.rejects(h.portal.acceptPortalQuote(h.req(), h.response()), error => error.code === "QUOTE_EXPIRED");
    assert.equal(h.calls.users, 1);
    assert.equal(h.calls.saved + h.calls.clients + h.calls.companies, 0);
    assert.equal(quote.status, "sent");
});

test("public expired link displays expiry without changing global quote validity", async () => {
    const h = harness();
    const quote = h.makeQuote("q", "sent", instant + 60_000, { responseTokenExpiresAt: new Date(instant - 1) });
    h.setRecords([quote]);
    const res = h.response();
    await h.quote.getPublicQuote(h.req(), res);
    assert.equal(res.body.quote.status, "expired");
    assert.equal(h.serializers.toPortalQuote(quote).status, "sent");
    assert.equal(quote.status, "sent");
    assert.equal(h.calls.saved, 0);
});

for (const expiredBy of ["quote", "token"]) {
    test(`public response rejects an expired ${expiredBy} before response effects`, async () => {
        const h = harness();
        const quote = h.makeQuote("q", "sent", expiredBy === "quote" ? instant - 1 : instant + 60_000,
            { responseTokenExpiresAt: new Date(expiredBy === "token" ? instant - 1 : instant + 60_000) });
        h.setRecords([quote]);
        const req = h.req();
        req.body = { action: "accept", name: "Client", email: "client@example.test" };
        await assert.rejects(h.quote.respondToPublicQuote(req, h.response()), error => error.code === "QUOTE_EXPIRED");
        assert.equal(h.calls.saved + h.calls.clients + h.calls.users + h.calls.companies, 0);
    });
}

test("portal responses do not depend on an expired public link", async () => {
    const h = harness();
    const quote = h.makeQuote("q", "sent", instant + 60_000,
        { responseTokenExpiresAt: new Date(instant - 1), depositPercentage: 0 });
    h.setRecords([quote]);
    const res = h.response();
    await h.portal.acceptPortalQuote(h.req(), res);
    assert.equal(res.body.status, "accepted");
    assert.equal(quote.acceptedBy.email, "client@example.test");
    assert.equal(h.calls.saved, 1);
});

test("shared mutation independently rejects expiry before conversion or deposit work", async () => {
    const h = harness();
    await assert.rejects(h.quote.applyQuoteResponse(h.makeQuote("q", "sent", instant - 1), {
        action: "accept", name: "Client", email: "client@example.test",
    }), error => error.code === "QUOTE_EXPIRED");
    assert.equal(h.calls.saved + h.calls.clients + h.calls.users + h.calls.companies, 0);
});

test("sending cannot resend effectively expired sent/viewed quotes", async () => {
    const h = harness();
    for (const status of ["sent", "viewed"]) {
        await assert.rejects(h.quote.sendQuoteNow(h.makeQuote("q", status, instant - 1), companyId),
            error => error.statusCode === 400 && error.message.includes("expired"));
    }
    assert.equal(h.calls.saved + h.calls.clients + h.calls.users + h.calls.companies, 0);
});

test("draft first-send validation keeps the existing policy", async () => {
    const h = harness();
    await assert.rejects(h.quote.sendQuoteNow(h.makeQuote("q", "draft", instant - 1), companyId),
        error => error.statusCode === 400 && error.message.includes("billing email"));
});
