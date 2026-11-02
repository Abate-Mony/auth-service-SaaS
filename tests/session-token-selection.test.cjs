// node --test tests/session-token-selection.test.cjs
// Real authentication handlers/middleware; database, token generation and
// cookies are replaced in memory. Does not load bootstrap or environment files.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { test } = require("node:test");

const serverRoot = process.env.SERVER_ROOT || path.resolve(__dirname, "..");
const sourceRoot = process.env.SERVER_SESSION_SOURCE || serverRoot;
const serverRequire = createRequire(path.join(serverRoot, "package.json"));
const ts = serverRequire("typescript");

function harness() {
    const future = new Date(Date.now() + 60_000);
    const user = {
        _id: "user", role: "client", company: "company", client: "client", isActive: true,
        sessions: [
            { tokenHash: "hash:session-A", expiresAt: future },
            { tokenHash: "hash:session-B", expiresAt: future },
        ],
    };
    const calls = { found: [], updated: [], hashed: [], cookies: [], verified: [] };
    const queryResult = value => ({
        select() { return this; }, lean: async () => value,
        then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
    });
    const User = {
        findOne(query) { calls.found.push(query); return queryResult(user); },
        async updateOne(query, update) {
            calls.updated.push({ query, update });
            if (update.$pull) {
                user.sessions = user.sessions.filter(session => session.tokenHash !== update.$pull.sessions.tokenHash);
            }
            if (update.$push) user.sessions.push(...update.$push.sessions.$each);
            return { modifiedCount: 1 };
        },
    };
    const cache = new Map();
    function load(relative, useStaging = true) {
        const requested = path.join(useStaging ? sourceRoot : serverRoot, relative);
        const filename = fs.existsSync(requested) ? requested : path.join(serverRoot, relative);
        if (cache.has(filename)) return cache.get(filename).exports;
        const module = { exports: {} };
        cache.set(filename, module);
        const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
            compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
        });
        const requireStub = request => {
            if (request === "http-status-codes") return serverRequire(request);
            if (request.endsWith("/userModel.js")) return User;
            if (request.endsWith("/clientModel.js")) return { findOne: () => queryResult({ _id: "client", name: "Client" }) };
            if (request.endsWith("/company.js")) return { findById: () => queryResult({ name: "Company", timezone: "Europe/London" }) };
            if (request === "./authControler.js") return load("src/controllers/authControler.ts");
            if (request.endsWith("/customErrors.js")) return load("src/errors/customErrors.ts", false);
            if (request.endsWith("/cookieUtils.js")) return { setCookies: () => ({ httpOnly: true }) };
            if (request.endsWith("/passwordUtils.js")) return { comparePassword: async () => true };
            if (request.endsWith("/tokenUtils.js")) return {
                hashRefreshToken(token) { calls.hashed.push(token); return `hash:${token}`; },
                createAccessToken: () => "rotated-access",
                createRefreshToken: () => ({ token: "rotated-refresh", hash: "hash:rotated-refresh", expiresAt: future }),
                sanitizeUser: value => ({ _id: value._id, role: value.role }),
                verifyAccessToken(token) {
                    calls.verified.push(token);
                    if (token !== "access-A" && token !== "access-B") throw new Error("Invalid JWT");
                    return { user_id: token === "access-A" ? "user-A" : "user-B", role: "client", company_id: "company", client_id: "client" };
                },
            };
            return {};
        };
        const execute = vm.runInNewContext(`(function(require, module, exports) { ${outputText}\n})`, {
            Date, console, process: { env: {} },
        }, { filename });
        execute(requireStub, module, module.exports);
        return module.exports;
    }
    const auth = load("src/controllers/authControler.ts");
    const clientAuth = load("src/controllers/clientAuthController.ts");
    const middleware = load("src/middleware/authMiddleware.ts");
    const req = (bodyToken, cookieToken) => ({
        body: bodyToken === undefined ? {} : { refreshToken: bodyToken },
        cookies: cookieToken === undefined ? {} : { refreshToken: cookieToken },
    });
    const res = () => ({
        cookie(...args) { calls.cookies.push(args); return this; },
        status() { return this; }, json(body) { this.body = body; return this; },
    });
    return { auth, clientAuth, middleware, calls, user, req, res };
}

test("refresh rotates explicit body session A even with session B cookie", async () => {
    const h = harness();
    const res = h.res();
    await h.auth.refresh(h.req("session-A", "session-B"), res);
    assert.deepEqual(h.calls.hashed, ["session-A"]);
    assert.equal(h.calls.found[0].$or[1]["sessions.tokenHash"], "hash:session-A");
    assert.equal(h.calls.updated[0].update.$pull.sessions.tokenHash, "hash:session-A");
    assert.deepEqual(h.user.sessions.map(session => session.tokenHash), ["hash:session-B", "hash:rotated-refresh"]);
    assert.equal(res.body.refreshToken, "rotated-refresh");
    assert.equal(h.calls.cookies.length, 0);
});

test("logout revokes explicit body session A and retains session B", async () => {
    const h = harness();
    await h.auth.logout(h.req("session-A", "session-B"), h.res());
    assert.deepEqual(h.calls.hashed, ["session-A"]);
    assert.equal(h.calls.updated[0].query.$or[1]["sessions.tokenHash"], "hash:session-A");
    assert.equal(h.calls.updated[0].update.$pull.sessions.tokenHash, "hash:session-A");
    assert.deepEqual(h.user.sessions.map(session => session.tokenHash), ["hash:session-B"]);
    assert.equal(h.calls.cookies.length, 0);
});

test("cookie-only web refresh still rotates its own session", async () => {
    const h = harness();
    await h.auth.refresh(h.req(undefined, "session-B"), h.res());
    assert.deepEqual(h.calls.hashed, ["session-B"]);
    assert.deepEqual(h.user.sessions.map(session => session.tokenHash), ["hash:session-A", "hash:rotated-refresh"]);
    assert.equal(h.calls.cookies.length, 2);
    assert.equal(h.calls.cookies.find(([name]) => name === "refreshToken")[1], "rotated-refresh");
    assert.equal(h.calls.cookies.find(([name]) => name === "token")[1], "rotated-access");
});

test("cookie-only web logout still revokes its own session", async () => {
    const h = harness();
    await h.auth.logout(h.req(undefined, "session-B"), h.res());
    assert.deepEqual(h.calls.hashed, ["session-B"]);
    assert.deepEqual(h.user.sessions.map(session => session.tokenHash), ["hash:session-A"]);
    assert.equal(h.calls.cookies.length, 2);
    assert.ok(h.calls.cookies.every(([, value]) => value === "logout"));
});

for (const token of ["", {}, 123]) {
    test(`invalid explicit body token (${typeof token}) never falls back to another session`, async () => {
        const h = harness();
        await assert.rejects(h.auth.refresh(h.req(token, "session-B"), h.res()), error => error.statusCode === 401);
        await h.auth.logout(h.req(token, "session-B"), h.res());
        assert.deepEqual(h.calls.hashed, []);
        assert.equal(h.calls.found.length + h.calls.updated.length, 0);
        assert.deepEqual(h.user.sessions.map(session => session.tokenHash), ["hash:session-A", "hash:session-B"]);
        assert.equal(h.calls.cookies.length, 0);
    });
}

test("body refresh rejection cannot clear a newer browser session cookie", async () => {
    const h = harness();
    h.user.isActive = false;
    await assert.rejects(h.auth.refresh(h.req("session-A", "session-B"), h.res()), error => error.statusCode === 401);
    assert.equal(h.calls.cookies.length, 0);
    assert.equal(h.calls.updated.length, 0);
});

test("cookie-only refresh rejection retains existing cookie cleanup", async () => {
    const h = harness();
    h.user.isActive = false;
    await assert.rejects(h.auth.refresh(h.req(undefined, "session-B"), h.res()), error => error.statusCode === 401);
    assert.equal(h.calls.cookies.length, 2);
    assert.ok(h.calls.cookies.every(([, value]) => value === "logout"));
});

for (const scheme of ["Bearer", "bearer", "BEARER"]) {
test(`explicit ${scheme} A wins over a retained access cookie B`, () => {
    const h = harness();
    const req = { headers: { authorization: `${scheme} access-A` }, cookies: { token: "access-B" } };
    let nextCalls = 0;
    h.middleware.authenticateUser(req, h.res(), () => { nextCalls++; });
    assert.equal(req.user.user_id, "user-A");
    assert.equal(nextCalls, 1);
    assert.deepEqual(h.calls.verified, ["access-A"]);
});
}

for (const header of ["Bearer invalid", "Bearer ", "Bearer", "bearer ", "BEARER"]) {
    test(`invalid/empty explicit Bearer (${JSON.stringify(header)}) cannot fall back to cookie B`, () => {
        const h = harness();
        const req = { headers: { authorization: header }, cookies: { token: "access-B" } };
        assert.throws(() => h.middleware.authenticateUser(req, h.res(), () => assert.fail("Must reject")),
            error => error.statusCode === 401);
        assert.equal(req.user, undefined);
        assert.ok(!h.calls.verified.includes("access-B"));
    });
}

test("cookie-only access authentication keeps the existing browser behavior", () => {
    const h = harness();
    const req = { headers: {}, cookies: { token: "access-B" } };
    let nextCalls = 0;
    h.middleware.authenticateUser(req, h.res(), () => { nextCalls++; });
    assert.equal(req.user.user_id, "user-B");
    assert.equal(nextCalls, 1);
    assert.deepEqual(h.calls.verified, ["access-B"]);
});

test("client mobile login returns tokens without setting cookies", async () => {
    const h = harness();
    const req = { body: { email: "client@example.test", password: "password" } };
    const res = h.res();
    await h.clientAuth.clientMobileLogin(req, res);
    assert.equal(res.body.accessToken, "rotated-access");
    assert.equal(res.body.refreshToken, "rotated-refresh");
    assert.equal(h.calls.cookies.length, 0);
    assert.equal(h.calls.updated.length, 1);
});

test("worker mobile login returns tokens without setting cookies", async () => {
    const h = harness();
    h.user.role = "worker";
    const req = { body: { email: "worker@example.test", password: "password" } };
    const res = h.res();
    await h.auth.mobileLogin(req, res);
    assert.equal(res.body.accessToken, "rotated-access");
    assert.equal(res.body.refreshToken, "rotated-refresh");
    assert.equal(h.calls.cookies.length, 0);
    assert.equal(h.calls.updated.length, 1);
});

test("client web login keeps issuing access and refresh cookies", async () => {
    const h = harness();
    const req = { body: { email: "client@example.test", password: "password" } };
    await h.clientAuth.clientLogin(req, h.res());
    assert.equal(h.calls.cookies.length, 2);
    assert.equal(h.calls.cookies.find(([name]) => name === "refreshToken")[1], "rotated-refresh");
    assert.equal(h.calls.cookies.find(([name]) => name === "token")[1], "rotated-access");
});
