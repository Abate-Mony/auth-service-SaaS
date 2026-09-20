# INPRN External API

This is a read/write API for connecting your own systems — a booking
website, a Zapier flow, another internal tool — to your INPRN schedule. It
is a completely separate surface from the main INPRN app API: it's
authenticated by an **API key**, not a login session, and everything it
touches is scoped to your company automatically (the key carries that, you
never send a company id yourself).

**Safety rule that applies to every write this API can do: a job created
through this API always comes in as a `draft`.** It is never published,
never assigned a worker, and never visible to a worker's app until a
manager in INPRN reviews it and publishes it themselves. This API can
propose work; it can't put a real person on a real shift on its own.

## Getting a key

In the INPRN app: **Settings → API Keys → New key**. Only the company
owner can create or revoke keys. The raw key is shown exactly once, right
after creation — copy it somewhere safe immediately. INPRN only ever
stores a hash of it, so if you lose it, the only fix is to revoke it and
create a new one.

## Authentication

Every request needs the key as a Bearer token:

```
Authorization: Bearer ipk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Missing or invalid key → `401`. Revoked key → `401` (same response,
doesn't distinguish "never existed" from "revoked").

## Base URL

```
https://<your-inprn-api-host>/api/v1/external
```

## Rate limit

300 requests per 15 minutes per key. Beyond that you'll get a `429`.

---

## `GET /clients`

Look up your clients by name so you can resolve a name you already know to
the id the rest of this API needs.

```
GET /external/clients?search=acme
```

| Query param | Required | Notes |
|---|---|---|
| `search` | no | Case-insensitive, matches anywhere in the client name. Omit to list all (capped at 100). |

Only active clients are returned.

```json
{
  "success": true,
  "clients": [
    { "id": "66f1a2b3c4d5e6f7a8b9c0d1", "name": "Acme Security Ltd" }
  ]
}
```

## `GET /sites`

A client's saved locations, if they have any set up in INPRN.

```
GET /external/sites?clientId=66f1a2b3c4d5e6f7a8b9c0d1
```

| Query param | Required | Notes |
|---|---|---|
| `clientId` | yes | A real, active client id from `/clients`. |

```json
{
  "success": true,
  "sites": [
    { "id": "66f1a2b3c4d5e6f7a8b9c0d2", "name": "Warehouse — Bristol" }
  ]
}
```

## `GET /schedule`

Read jobs — this is the calendar/schedule read side.

```
GET /external/schedule?dateFrom=2026-10-01&dateTo=2026-10-31&status=published
```

| Query param | Required | Notes |
|---|---|---|
| `dateFrom` | no | `YYYY-MM-DD`, inclusive. |
| `dateTo` | no | `YYYY-MM-DD`, inclusive. |
| `status` | no | One of `draft`, `published`, `completed`, `cancelled`. |
| `clientId` | no | Filter to one client. |

Capped at 500 jobs per call — page with `dateFrom`/`dateTo` if you need more.

```json
{
  "success": true,
  "jobs": [
    {
      "id": "66f2b3c4d5e6f7a8b9c0d1e2",
      "title": "Night Shift — Warehouse",
      "date": "2026-10-15",
      "startTime": "20:00",
      "endTime": "06:00",
      "status": "published",
      "client": "Acme Security Ltd",
      "site": "Warehouse — Bristol",
      "requiredWorkers": 3,
      "assignedWorkers": 1,
      "externalReference": null
    }
  ]
}
```

`externalReference` echoes back whatever you sent when you created the job
via this API (see below) — `null` for jobs created inside INPRN itself.
This API never returns worker names, contact details, or pay rates.

## `POST /jobs`

Request a new shift. **Always creates a draft** — see the safety note at
the top of this doc.

```json
POST /external/jobs
Content-Type: application/json

{
  "clientId": "66f1a2b3c4d5e6f7a8b9c0d1",
  "siteId": "66f1a2b3c4d5e6f7a8b9c0d2",
  "title": "Night Shift — Warehouse",
  "description": "Security cover for the new stock delivery.",
  "date": "2026-10-15",
  "startTime": "20:00",
  "endTime": "06:00",
  "requiredWorkers": 3,
  "notes": "Gate code changes weekly — check with site manager.",
  "externalReference": "BOOKING-4471"
}
```

| Field | Required | Notes |
|---|---|---|
| `clientId` | yes | A real, active client id from `/clients`. |
| `siteId` | no* | A real, active site id belonging to that client, from `/sites`. |
| `location` | no* | A free-text one-off address, if you're not using a saved site. |
| `title` | yes | Shift name/title. |
| `description` | no | Falls back to `title` if omitted. |
| `date` | yes | `YYYY-MM-DD`. |
| `startTime` / `endTime` | yes | `HH:mm`, 24-hour. An end time at or before the start time is treated as an overnight shift (rolls into the next day). |
| `requiredWorkers` | no | Defaults to `1`. Max `200`. |
| `address` | no | Extra address detail, only used alongside `location` (ignored if `siteId` is set). |
| `notes` | no | Shown to the manager reviewing the draft. |
| `externalReference` | no | Your own booking/order id — echoed back on every response so you don't need to store ours. |

\* Provide either `siteId` or `location` — one of the two is required.

```json
{
  "success": true,
  "job": {
    "id": "66f2b3c4d5e6f7a8b9c0d1e2",
    "title": "Night Shift — Warehouse",
    "date": "2026-10-15",
    "startTime": "20:00",
    "endTime": "06:00",
    "status": "draft",
    "externalReference": "BOOKING-4471"
  }
}
```

`status` is always `"draft"` in this response — that's not a bug, it's the
whole point. Poll `GET /schedule` (or check inside INPRN) if you need to
know once a manager has published it.

## Error reference

| Status | Message | When |
|---|---|---|
| 401 | `Missing or invalid API key.` | No `Authorization` header, a malformed key, or a revoked/unknown one. |
| 400 | `A valid clientId is required.` | `clientId` missing or not a valid id shape. |
| 400 | `Client not found, inactive, or doesn't belong to this company.` | `clientId` doesn't resolve to one of your active clients. |
| 400 | `Site not found, inactive, or doesn't belong to this client.` | `siteId` doesn't belong to the given `clientId`, or is inactive. |
| 400 | `Provide either a siteId or a location for a one-off address.` | Neither was sent. |
| 400 | `startTime must be HH:mm` / `endTime must be HH:mm` | Wrong time format. |
| 429 | (rate limit response) | More than 300 requests in 15 minutes on this key. |

## Example client (Node.js / axios)

The key only ever needs to go in the `Authorization` header — set it once
on an axios instance and every call inherits it.

```js
import axios from "axios";

const inprn = axios.create({
  baseURL: "https://<your-inprn-api-host>/api/v1/external",
  headers: {
    Authorization: `Bearer ${process.env.INPRN_API_KEY}`,
  },
});

// GET /clients?search=
export async function findClient(name) {
  const { data } = await inprn.get("/clients", { params: { search: name } });
  return data.clients[0] ?? null; // { id, name } | undefined
}

// GET /sites?clientId=
export async function getSitesForClient(clientId) {
  const { data } = await inprn.get("/sites", { params: { clientId } });
  return data.sites; // [{ id, name }]
}

// GET /schedule?dateFrom=&dateTo=
export async function getSchedule(dateFrom, dateTo) {
  const { data } = await inprn.get("/schedule", { params: { dateFrom, dateTo } });
  return data.jobs;
}

// POST /jobs — always comes back as status: "draft"
export async function requestBooking(booking) {
  const { data } = await inprn.post("/jobs", {
    clientId: booking.clientId,
    siteId: booking.siteId, // omit if using `location` instead
    title: booking.title,
    date: booking.date, // "YYYY-MM-DD"
    startTime: booking.startTime, // "HH:mm"
    endTime: booking.endTime, // "HH:mm"
    requiredWorkers: booking.requiredWorkers ?? 1,
    notes: booking.notes,
    externalReference: booking.orderId, // your own id, echoed back
  });
  return data.job;
}
```

Handling errors — every failure is `{ msg: "<human-readable message>" }`,
the same shape documented in the error table above:

```js
try {
  const job = await requestBooking(booking);
} catch (err) {
  if (axios.isAxiosError(err)) {
    console.error(err.response?.status, err.response?.data?.msg);
    // e.g. 400 "Client not found, inactive, or doesn't belong to this company."
  }
  throw err;
}
```

## A typical integration flow

1. `GET /clients?search=<name>` once, at setup time, to find the `clientId` you'll use going forward (or hardcode it if your integration only ever books for one client).
2. Optionally `GET /sites?clientId=...` if you want to let the booker pick a saved site rather than typing an address.
3. When a booking comes in on your site: `POST /jobs` with your own `externalReference` for reconciliation.
4. A manager reviews and publishes the draft inside INPRN — no further action needed from your side unless you want to reflect the published status back to your own users, in which case poll `GET /schedule?dateFrom=...&dateTo=...` and match on `externalReference`.
