# Task: Implement Client management + the Job-form Client picker

## Context

The backend now has a real `Client` entity (name, contacts, billing info,
address, default charge rate/type, active/inactive status) instead of
`Job.client` being a free-text string. This is a **breaking change** to
the Job API's `client` field — coordinate with backend on deploy timing
(see §7). Don't ship this frontend work against a backend that hasn't
deployed the corresponding change, and don't let the old frontend keep
running against a backend that has.

Auth is cookie-based as usual — `credentials: "include"` on every call.
All Client endpoints are admin/manager only (a worker gets `403`).

## 1. Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/v1/clients?search=&status=&page=&limit=` | List + the job-form typeahead |
| `POST` | `/api/v1/clients` | Create — only `name` is required |
| `GET` | `/api/v1/clients/:id` | Detail + stats |
| `PATCH` | `/api/v1/clients/:id` | Edit |
| `DELETE` | `/api/v1/clients/:id` | Admin-only, soft-delete, refused if jobs/invoices exist |
| `PATCH` | `/api/v1/clients/:id/status` | `{ status: "active" | "inactive" }` |

## 2. List / typeahead — `GET /clients`

```js
GET /api/v1/clients?search=tesco&status=active&page=1&limit=10
```

`status` is `active | inactive | all` (omit = all). `search` matches
client name and contact names, case-insensitive.

```json
{
  "success": true,
  "clients": [
    {
      "_id": "...",
      "name": "Tesco Extra",
      "status": "active",
      "contacts": [{ "name": "Jane Doe", "role": "Site Manager", "isPrimary": true, "...": "..." }],
      "phone": "...",
      "billingEmail": "...",
      "defaultChargeType": "hourly",
      "defaultChargeRate": 18.5,
      "jobCount": 12,
      "totalInvoiced": 4320.5,
      "...": "(full Client doc, minus nothing sensitive)"
    }
  ],
  "page": 1,
  "limit": 10,
  "total": 3,
  "totalPages": 1
}
```

`jobCount`/`totalInvoiced` are computed server-side per client — no extra
requests needed to show them in a table row.

**Use this same endpoint for the Job-form Client picker** (`?search=&status=active&limit=10`)
— there is no separate typeahead endpoint. Always pass `status=active`
there specifically; inactive clients shouldn't be selectable for a *new*
job assignment (they still show up fine on the general Clients management
page without that filter).

## 3. Client detail — `GET /clients/:id`

```json
{
  "success": true,
  "client": { "...full Client doc..." },
  "stats": {
    "totalJobs": 12,
    "upcomingJobs": 3,
    "totalInvoiced": 4320.50,
    "outstandingBalance": 850.00
  },
  "recentJobs": [
    { "_id": "...", "title": "Office cleaning", "date": "...", "status": "completed" }
  ]
}
```

`recentJobs` is capped at 10, most recent first. `outstandingBalance`
only counts `sent` invoices that aren't fully paid (draft invoices don't
count as owed yet; paid ones are naturally 0).

## 4. Create — `POST /clients`

Only `name` is required:

```json
{ "name": "Acme Security" }
```

Full shape (everything but `name` optional):

```json
{
  "name": "Acme Security",
  "contacts": [{ "name": "Jane Doe", "role": "Site Manager", "email": "jane@acme.com", "phone": "...", "isPrimary": true }],
  "phone": "...",
  "billingEmail": "billing@acme.com",
  "vatNumber": "GB123456789",
  "address": { "line1": "...", "city": "...", "postcode": "...", "country": "United Kingdom" },
  "defaultChargeType": "hourly",
  "defaultChargeRate": 18.5,
  "paymentTermsDays": 30,
  "status": "active",
  "notes": "..."
}
```

Response `201 { success: true, client }` — the returned `client` has a
real `_id`, immediately usable to select in the job form (this is what
powers "quick-create a client from the job form without leaving it").

**Reject unknown fields** — the backend uses a strict schema, so sending
anything not in the list above (e.g. `company`, `createdBy`, `_id`) gets
a `400`, not silently ignored. Don't build a form that sends extra junk
fields.

Duplicate name in the same company → `400`, message is exactly
`"A client called 'X' already exists."` — safe to show directly.

## 5. Edit — `PATCH /clients/:id`

Same shape as create, all fields optional, same strict-unknown-key
rejection, same duplicate-name error. Sending `{}` gets `400 "No valid
fields provided."`

## 6. Delete vs. deactivate

- `DELETE /clients/:id` (admin only) — soft-delete, but **refused** if
  the client has any non-deleted job or invoice:
  ```json
  { "msg": "This client has 14 jobs and 3 invoices. Set them to inactive instead." }
  ```
  Show this as the actual next step, not a dead-end error — surface a
  button to the status toggle right in that error state.
- `PATCH /clients/:id/status` `{ status: "inactive" }` — the real
  "archive" action for any client with history. Reversible
  (`{ status: "active" }` un-archives). Inactive clients keep their jobs
  and invoices and can still be viewed/edited; they just shouldn't appear
  in the active-only job-form typeahead (pass `status=active` there, per §2).

## 7. Breaking change to the Job API — deployment coordination

**`Job.client` is no longer a string.** It's `null`, or a Client
reference. Two different shapes depending on which endpoint returns it:

- List (`GET /jobs`) and calendar: `client: { "_id": "...", "name": "Tesco Extra" } | null`
- Detail (`GET /jobs/:id`): fuller — `client: { "_id", "name", "status", "contacts", "phone", "billingEmail", "address", "defaultChargeType", "defaultChargeRate" } | null`

And when **creating/editing** a job, `client` in the request body must be:
- omitted or `null` — no client (internal/training work; this is
  legitimate, don't force a selection)
- a real Client `_id` string — validated server-side (must belong to your
  company, not deleted, and **active**)

Sending the old free-text name (`"client": "Tesco Extra"`) now gets
`400 "Invalid client id."` — there is no backward-compatible fallback.
**This is why timing matters**: if this frontend work ships before the
backend deploys the change, job creation with a client will start
failing the moment it does, and vice versa — old frontend against new
backend fails immediately too. Deploy both together, or gate the new
Client-picker UI behind a flag until the backend change is confirmed live.

### Charge defaults on job creation

When a job is created with a client attached and `chargeRate`/`chargeType`
are omitted from the request, the server fills them from that client's
`defaultChargeRate`/`defaultChargeType`. If the job form explicitly sets a
rate (including `0`), that always wins — the default only fills a gap,
it never overwrites an explicit value. This means: don't pre-fill the
charge rate field with the client's default and then also omit it from
the request thinking the server will do the same thing — either send
what's in the field (explicit) or leave the field truly empty/omitted
(server default applies). Sending `0` explicitly is different from
omitting the field.

**On edit, this does not re-apply** — changing a job's client does not
silently change its existing charge rate. If you want an "apply this
client's defaults" action on edit, that needs its own explicit UI control
that sends the rate fields itself; there's no server-side magic for it.

### Filtering jobs by client

```js
GET /api/v1/jobs?client=<clientId>
```

Must be a real Client `_id` — an invalid one gets `400`.

## 8. Error reference

| Status | Message pattern | When |
|---|---|---|
| 400 | `Invalid client id.` | Malformed/non-existent id sent as a job's client |
| 400 | `Client not found.` | Valid-looking id, but wrong company / deleted |
| 400 | `Client must be active before it can be assigned to a new job.` | Client exists but is `inactive` |
| 400 | `A client called 'X' already exists.` | Duplicate name on create/edit |
| 400 | `This client has N jobs and M invoices. Set them to inactive instead.` | Delete blocked by dependencies |
| 404 | `Client not found.` | GET/PATCH/DELETE on a missing/cross-company client |

## 9. Testing checklist

- Job form: search for a client by partial name, select it, create the
  job, confirm the created job's `client` comes back populated correctly.
- Job form: leave client empty, confirm the job creates fine with no client.
- Quick-create: type a brand-new client name in the picker, create it via
  `POST /clients` with just `{ name }`, immediately select the returned
  `_id` without a page reload.
- Try assigning an **inactive** client to a new job → confirm the
  friendly "must be active" error surfaces, not a raw 400 dump.
- Edit an existing job's client to a different one → confirm the job's
  existing chargeRate is unchanged.
- Create a job with a client and no explicit `chargeRate` → confirm the
  saved job picked up the client's `defaultChargeRate`.
- Try deleting a client with existing jobs → confirm the dependency-count
  error, and that the UI offers "set inactive" instead of a dead end.
- Deactivate a client, confirm it disappears from the job-form typeahead
  (`status=active`) but still shows on the general Clients list and is
  still viewable/selected on jobs it's already attached to.
- Reactivate it, confirm it's selectable again.
- As a `worker`-role user, hit any `/clients` endpoint → confirm `403`.
