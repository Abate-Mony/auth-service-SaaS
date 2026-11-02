// Runs real handlers with in-memory database and push adapters. No network,
// application bootstrap, production environment or database connection.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const serverRoot = process.env.SERVER_ROOT || path.resolve(__dirname, '..');
const sourceRoot = process.env.BOOKING_NOTIFICATION_SOURCE || serverRoot;
const dep = createRequire(path.join(serverRoot, 'package.json'));
const ts = dep('typescript');
const userId = '111111111111111111111111';
const company = '222222222222222222222222';
const client = '333333333333333333333333';
const jobId = '444444444444444444444444';
const token = 'ExponentPushToken[test-device]';
const registrationId = 'registration-owner-12345';

function harness() {
  const calls = { notifications: [], pushes: [], queries: [], updates: [], logs: [] };
  const users = [{ _id: userId, company, client, role: 'client', clientRole: 'owner', isActive: true }];
  const state = { failInbox: false, failPush: false };
  const request = { _id: 'request', company, client, requestedBy: userId, status: 'pending', service: 'Office cleaning', type: 'reschedule', job: jobId,
    async save() { calls.logs.push('request-saved'); } };
  const job = { _id: jobId, company, client, title: 'Office clean', status: 'published', isTemplate: false,
    date: new Date('2026-11-15T00:00:00Z'), startTime: '09:00', endTime: '12:00' };
  const User = {
    find(query) { calls.queries.push(['recipients', query]); return { select: () => ({ lean: async () => users.filter(u =>
      Object.entries(query).every(([key, value]) => String(u[key]) === String(value))) }) }; },
    findOne(query) { calls.queries.push(['user', query]); return { select: async () => users.find(u =>
      Object.entries(query).every(([key, value]) => String(u[key]) === String(value))) }; },
    findById() { return { select: async () => ({ fullname: 'Client', email: null, expoPushTokens: [], clientPushTokens: [{ token, registrationId }] }) }; },
    async updateOne(query, update) { calls.updates.push({ query, update }); return { modifiedCount: 1 }; },
    async updateMany(query, update) { calls.updates.push({ query, update }); return { modifiedCount: 1 }; },
  };
  const Notification = {
    async create(value) { if (state.failInbox) throw new Error('inbox unavailable'); calls.notifications.push(value); calls.logs.push('inbox'); return value; },
    find(query) { calls.queries.push(['inbox', query]); const chain = { sort: () => chain, skip: n => { calls.skip = n; return chain; }, limit: async n => { calls.limit = n; return []; } }; return chain; },
    async countDocuments(query) { calls.queries.push(['count', query]); return 0; },
    async findOneAndUpdate(query, update) { calls.updates.push({ query, update }); return query.user === userId && query.company === company ? { _id: query._id, isRead: true } : null; },
    async updateMany(query, update) { calls.updates.push({ query, update }); },
  };
  const Request = { async findOne(query) { calls.queries.push(['request', query]); return query.client && query.client !== request.client ? null : request; } };
  class Expo {
    static isExpoPushToken(value) { return typeof value === 'string' && /^ExponentPushToken\[.+\]$/.test(value); }
    chunkPushNotifications(messages) { return [messages]; }
    async sendPushNotificationsAsync(messages) { calls.pushes.push(...messages); return messages.map(() => ({ status: 'ok' })); }
  }
  const cache = new Map();
  function load(relative) {
    if (cache.has(relative)) return cache.get(relative).exports;
    const candidate = path.join(sourceRoot, relative);
    const filename = fs.existsSync(candidate) ? candidate : path.join(serverRoot, relative);
    let text = fs.readFileSync(filename, 'utf8');
    if (relative.endsWith('/jobController.ts')) text += '\nexport { maybeApproveBookingRequest, maybeApproveJobChangeRequest };';
    const subject = new Module(filename, module);
    cache.set(relative, subject);
    subject.filename = filename;
    subject.paths = Module._nodeModulePaths(path.dirname(filename));
    subject.require = name => {
      if (name === 'expo-server-sdk') return { Expo };
      if (!name.startsWith('.')) return dep(name);
      if (name.endsWith('/userModel.js')) return User;
      if (name.endsWith('/Notification.js')) return Notification;
      if (name.endsWith('/BookingRequest.js') || name.endsWith('/JobChangeRequest.js')) return Request;
      if (name.endsWith('/jobModel.js')) return { findOne: async () => job };
      if (name.endsWith('/jobAssignmentModel.js')) return { find: () => ({ populate: async () => [] }) };
      if (name.endsWith('/notificationPreferenceService.js')) return { shouldNotify: async () => false };
      if (name.endsWith('/expoPush.js') && !relative.endsWith('/expoPush.ts')) return { sendExpoPushToUser: async (id, payload) => {
        if (state.failPush) throw new Error('push unavailable'); calls.pushes.push({ id, payload }); calls.logs.push('push');
      } };
      if (name.endsWith('/activityLogger.js') || name.endsWith('/activityLog.js')) return { logActivity: async () => {} };
      if (name.endsWith('/tokenUtils.js')) return { hashRefreshToken: value => 'hash:' + value };
      const normalized = path.relative(path.join(serverRoot, 'src'), path.resolve(path.dirname(path.join(serverRoot, relative)), name)).replaceAll('\\', '/').replace(/\.js$/, '.ts');
      if (['utils/notifyClientBooking.ts','utils/clientPermissions.ts','errors/customErrors.ts','interfaces/expresstype.ts','controllers/portalPushController.ts'].includes(normalized)) return load('src/' + normalized);
      if (name.includes('/models/')) return {};
      return {};
    };
    subject._compile(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
    return subject.exports;
  }
  const req = (body = {}) => ({ user: { user_id: userId, company_id: company, client_id: client }, body, query: {}, params: { id: jobId }, cookies: {} });
  const res = () => ({ status() { return this; }, json(value) { this.body = value; return this; }, cookie() { return this; } });
  return { calls, users, state, request, job, load, req, res };
}

test('published approval is scoped to matching client and targets its requester', async () => {
  const h = harness();
  await h.load('src/controllers/jobController.ts').maybeApproveBookingRequest('request', company, userId, h.job);
  assert.equal(h.request.status, 'approved');
  assert.equal(h.calls.notifications.length, 1);
  assert.equal(h.calls.notifications[0].link, '/bookings/' + jobId);
  assert.deepEqual(h.calls.logs.slice(0, 3), ['request-saved', 'inbox', 'push']);
  assert.equal(h.calls.queries.find(q => q[0] === 'request')[1].client, client);
});
test('draft/template approval confirms request without exposing unpublished booking', async () => {
  const h = harness(); h.job.status = 'draft'; h.job.isTemplate = true; h.job.title = 'Private staff scheduling plan';
  await h.load('src/controllers/jobController.ts').maybeApproveBookingRequest('request', company, userId, h.job);
  assert.equal(h.calls.notifications[0].link, '/bookings');
  assert.ok(!h.calls.notifications[0].body.includes(h.job.title));
});
test('mismatched client cannot approve or notify another clients request', async () => {
  const h = harness(); h.job.client = 'different-client';
  await h.load('src/controllers/jobController.ts').maybeApproveBookingRequest('request', company, userId, h.job);
  assert.equal(h.request.status, 'pending'); assert.equal(h.calls.notifications.length, 0);
});
test('request decline writes an actionable in-app update after saving review', async () => {
  const h = harness();
  await h.load('src/controllers/bookingRequestController.ts').declineBookingRequest(h.req({ reviewNotes: 'Choose another day' }), h.res());
  assert.equal(h.calls.notifications[0].type, 'booking_request_declined');
  assert.equal(h.calls.notifications[0].link, '/bookings');
  assert.ok(h.calls.notifications[0].body.includes('Choose another day'));
});
test('reschedule approval produces one update and skips a duplicate time-change review', async () => {
  const h = harness(); const handler = h.load('src/controllers/jobController.ts').maybeApproveJobChangeRequest;
  await handler('request', company, userId, h.job, true);
  assert.equal(h.request.status, 'approved'); assert.equal(h.calls.notifications.length, 0);
  h.request.status = 'pending';
  await handler('request', company, userId, h.job, false);
  assert.equal(h.calls.notifications[0].type, 'reschedule_request_approved');
});
test('client delivery filters company, client, active state and booking permissions', async () => {
  const h = harness();
  h.users.push({ ...h.users[0], _id: 'billing', clientRole: 'billing' }, { ...h.users[0], _id: 'inactive', isActive: false }, { ...h.users[0], _id: 'other', company: 'other-company' });
  await h.load('src/utils/notifyClientBooking.ts').notifyClientBooking({ companyId: company, clientId: client, event: 'booking_time_changed', title: 'Changed', body: '09:00', link: '/bookings/' + jobId });
  assert.deepEqual(h.calls.notifications.map(n => n.user), [userId]);
});
for (const failure of ['failInbox', 'failPush']) test('delivery remains best effort when ' + failure, async t => {
  t.mock.method(console, 'error', () => {});
  const h = harness(); h.state[failure] = true;
  await h.load('src/utils/notifyClientBooking.ts').notifyClientBooking({ companyId: company, clientId: client, event: 'booking_cancelled', title: 'Cancelled', body: 'Cancelled', link: '/bookings' });
  assert.equal(failure === 'failInbox' ? h.calls.pushes.length : h.calls.notifications.length, 1);
});
test('inbox list and unread count are scoped to user and tenant with bounded pagination', async () => {
  const h = harness(); const req = h.req(); req.query = { limit: '999', page: '2' };
  await h.load('src/controllers/notificationController.ts').getMyNotifications(req, h.res());
  assert.equal(h.calls.limit, 50); assert.equal(h.calls.skip, 50);
  h.calls.queries.forEach(([, query]) => { assert.equal(query.user, userId); assert.equal(query.company, company); });
});
test('read and read-all cannot change another user or tenants inbox', async () => {
  const h = harness(); const api = h.load('src/controllers/notificationController.ts');
  await api.markNotificationRead(h.req(), h.res()); await api.markAllNotificationsRead(h.req(), h.res());
  h.calls.updates.forEach(({ query }) => { assert.equal(query.user, userId); assert.equal(query.company, company); });
  const req = h.req(); req.params.id = 'malformed';
  await assert.rejects(api.markNotificationRead(req, h.res()), /not found/i);
});
test('register migrates legacy tokens and logout removes only its exact binding', async () => {
  const h = harness(); const api = h.load('src/controllers/portalPushController.ts');
  await api.saveClientPushToken(h.req({ token, registrationId }), h.res());
  assert.equal(h.calls.updates[0].update.$pull.expoPushTokens, token);
  await api.removeClientPushToken(h.req({ token, registrationId }), h.res());
  const update = h.calls.updates.at(-1);
  assert.equal(update.query._id, userId); assert.equal(update.query.company, company);
  assert.deepEqual(update.update.$pull.clientPushTokens, { token, registrationId });
  await assert.rejects(api.saveClientPushToken(h.req({ token: 'invalid', registrationId }), h.res()), /valid Expo/);
});
test('refresh-session logout carries exact push ownership without touching a new binding', async () => {
  const h = harness();
  await h.load('src/controllers/authControler.ts').logout(h.req({ refreshToken: 'session-a', clientPushRegistration: { token, registrationId } }), h.res());
  assert.equal(h.calls.updates[0].query.$or[0].refreshToken, 'hash:session-a');
  assert.deepEqual(h.calls.updates[0].update.$pull.clientPushTokens, { token, registrationId });
});
test('Expo sender includes client registrations and recipient identity in device payload', async () => {
  const h = harness();
  await h.load('src/utils/expoPush.ts').sendExpoPushToUser(userId, { title: 'Approved', body: 'Confirmed', url: '/bookings/' + jobId, tag: 'approved' });
  assert.equal(h.calls.pushes[0].to, token); assert.equal(h.calls.pushes[0].data.userId, userId);
  assert.equal(h.calls.pushes[0].data.url, '/bookings/' + jobId);
});
