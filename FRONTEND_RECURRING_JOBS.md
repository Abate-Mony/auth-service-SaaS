# Task: Implement Recurring Job Schedule management on the frontend

## Context

A **recurring job** isn't one record — it's two things working together:

- A `RecurringJob` **schedule** (frequency, interval, days of week, start/end
  date, default workers) — the rule.
- Many `Job` **occurrences** — real, individual shifts generated from that
  rule, the same `Job` documents that show up everywhere else in the app
  (calendar, job list, worker's "My Jobs").

This doc covers managing the *schedule* (list, view, edit, cancel,
reactivate). It does **not** cover creating one — that already goes through
the existing job-creation flow. There's also no delete: a schedule is
stopped (`cancel`) and can be started again (`reactivate`), never removed.

All routes are admin/manager only — a worker calling any of these gets a
plain `403`. Cookie-based auth as usual: `credentials: "include"` on every
call.

## 1. Creating a schedule — via the existing job endpoint, not this router

```js
POST /api/v1/jobs
{
  "title": "Office cleaning",
  "startTime": "18:00",
  "endTime": "20:00",
  "date": "2026-09-01",          // first occurrence's date
  "location": "...",
  "isRecurring": true,
  "frequency": "weekly",          // "daily" | "weekly" | "monthly"
  "interval": 1,                  // every N days/weeks/months
  "daysOfWeek": [1, 3, 5],         // required for weekly — 0=Sun..6=Sat
  "endDate": "2026-12-01",         // optional
  "maxOccurrences": 20,            // optional
  "workers": [{ "email": "..." }], // optional — becomes defaultWorkers
  "generateAheadDays": 30          // optional, defaults to company setting
}
```

Response: `201 { success: true, recurringJob, templateJob, generatedJobs, generatedCount }`.

- `templateJob` is an internal draft record (never shown in any job list) —
  don't render it as a real shift.
- `generatedJobs` are the actual upcoming occurrences created immediately
  (bounded by `generateAheadDays`, default from company settings)  — more
  get generated later by a nightly job as the window rolls forward.
- If workers were included, they get **one** "you've been added to a
  recurring shift" email/push summarizing all `generatedCount` occurrences
  — not one notification per occurrence.

## 2. List schedules

```js
GET /api/v1/recurring-jobs?active=true&page=1&limit=20
```

`active` is optional (`"true"` / `"false"` / omit for both).

```json
{
  "success": true,
  "schedules": [
    {
      "_id": "...",
      "frequency": "weekly",
      "interval": 1,
      "daysOfWeek": [1, 3, 5],
      "startDate": "...",
      "endDate": "...",
      "active": true,
      "templateJob": { "title": "Office cleaning", "location": "...", "startTime": "18:00", "endTime": "20:00" },
      "occurrenceCount": 12,
      "upcomingCount": 8,
      "nextOccurrence": "2026-09-08T00:00:00.000Z"
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 3,
  "totalPages": 1
}
```

`occurrenceCount`/`upcomingCount`/`nextOccurrence` are computed server-side
per schedule — enough to render a schedules table without a second request
per row.

## 3. Schedule detail

```js
GET /api/v1/recurring-jobs/:id
```

```json
{
  "success": true,
  "schedule": {
    "_id": "...",
    "templateJob": { "...full job doc..." },
    "defaultWorkers": [{ "_id": "...", "fullname": "...", "email": "..." }],
    "createdBy": { "_id": "...", "fullname": "..." },
    "frequency": "weekly",
    "...": "..."
  },
  "occurrences": {
    "upcoming": [{ "_id", "title", "date", "startTime", "endTime", "status", "requiredWorkers" }],
    "past": [{ "...same shape..." }],
    "total": 12
  }
}
```

Use `occurrences.upcoming`/`past` to render the "here's what's actually
scheduled" list on the detail page — this is a good place to link each
occurrence to its normal job-detail view (they're regular `Job` documents).

## 4. Edit a schedule

```js
PATCH /api/v1/recurring-jobs/:id
{
  "frequency": "weekly",
  "interval": 2,
  "daysOfWeek": [2, 4],
  "endDate": "2027-01-01",
  "maxOccurrences": 30,
  "defaultWorkers": ["userId1", "userId2"]
}
```

All fields optional — only send what changed.

**Important behavior to surface in the UI**: changing the pattern
regenerates future occurrences under the new rule. Concretely:

- Any future occurrence that's still `pending` (no worker has accepted or
  started it) is **deleted and replaced** under the new pattern.
- Any future occurrence where a worker has already accepted/started it is
  **left untouched** — the new pattern doesn't retroactively cancel
  someone's already-accepted shift. The manager sees it and deals with it
  separately (e.g. via the normal job cancel flow).
- Nothing in the past, and nothing `completed`/`cancelled`, is ever touched.

So after a successful edit, tell the user something like *"Schedule
updated. N shift(s) regenerated under the new pattern — any already
accepted by a worker were left as-is."* rather than implying every future
shift changed uniformly. Response: `200 { success, schedule, regenerated }`
— `regenerated` is the count of newly created occurrences.

## 5. Cancel a schedule

```js
PATCH /api/v1/recurring-jobs/:id/cancel
{ "cancelFutureJobs": false }
```

This is **two distinct decisions bundled into one call**, and the UI should
present them as such — don't just have a single "Cancel" button with no
explanation:

- `cancelFutureJobs: false` (default) — stop generating new occurrences,
  but every shift already on the calendar stays exactly as it is. Use this
  for "we're not renewing this contract past what's already scheduled."
- `cancelFutureJobs: true` — also cancel every upcoming, not-yet-worked
  occurrence, and cancel their pending/accepted assignments. Use this for
  "stop everything now."

Suggested UI: a confirmation dialog with a checkbox — *"Also cancel N
upcoming shift(s) that are already scheduled"* — rather than two separate
buttons that are easy to confuse.

Response:

```json
{
  "success": true,
  "message": "Schedule stopped and 5 upcoming shifts cancelled.",
  "cancelledJobs": 5,
  "notifiedWorkers": ["jane@x.com", "bob@x.com"]
}
```

`notifiedWorkers` is the list of emails whose **accepted** shifts got
pulled — worth showing ("These workers had accepted a now-cancelled shift:
...") since, as of today, the backend collects this list but doesn't
actually email them itself. If that matters for your rollout, flag it back
— it's a one-line addition to wire up, just not done yet.

Completed and in-progress shifts are never touched by either mode —
finished work stays on the timesheet, and nobody gets pulled off a shift
they're currently working.

## 6. Reactivate a schedule

```js
PATCH /api/v1/recurring-jobs/:id/reactivate
```

No body. Turns a stopped schedule back on and immediately generates new
occurrences going forward from **today** (not from whenever it was
stopped — so pausing a schedule for a month doesn't backfill a month of
shifts nobody worked).

- `400` if the schedule is already active — don't show a reactivate
  button on an active schedule to begin with.
- `400` if the schedule's `endDate` has already passed — the error message
  says as much ("Set a new end date before reactivating"); route the user
  to the edit form to fix `endDate` first.

Response: `200 { success, message, generated }`.

## 7. Error handling

All errors here are the standard `{ msg }` shape — `404` for a
missing/wrong-company schedule id (schedules are company-scoped like
everything else, so a stale/cross-tenant id just looks like "not found"),
`400` for validation failures (bad frequency, `daysOfWeek` out of range,
`endDate` before `startDate`, etc.) with a human-readable `msg` safe to
show directly.

## 8. Testing checklist

- Create a weekly recurring job with 2 workers → schedule + several
  occurrences appear, each worker gets exactly one summary email/push (not
  one per occurrence).
- List schedules, confirm `occurrenceCount`/`nextOccurrence` match what's
  actually on the calendar.
- Edit a schedule's `daysOfWeek` → confirm untouched: any occurrence a
  worker already accepted. Confirm changed: pending future occurrences now
  land on the new days.
- Cancel with `cancelFutureJobs: false` → schedule stops appearing as
  "active", but existing calendar entries are unaffected.
- Cancel with `cancelFutureJobs: true` on a schedule with an accepted
  future shift → that shift's status becomes `cancelled`, and its worker's
  email shows up in `notifiedWorkers`.
- Reactivate a cancelled schedule → new occurrences appear starting today,
  not backdated.
- Try reactivating a schedule whose `endDate` is in the past → clear `400`
  guiding the user to edit the end date first.
- As a `worker` role, hit any of these five routes → `403`.
- Confirm a schedule from a different company never shows up or is
  reachable by id (should 404, not leak data).
