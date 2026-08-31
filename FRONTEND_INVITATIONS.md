# Task: Implement Team Invitations on the frontend

## Context

The backend now supports a full invite-by-email flow, replacing the old
"admin picks a password for the worker" approach. This doc describes what
actually exists on the backend so you can build the Team page, invite
dialog, and public accept-invite flow against it.

Auth in this app is cookie-based (httpOnly `token`/`refreshToken` cookies)
— every `fetch` needs `credentials: "include"`. The public routes below
(`/validate`, `/accept`) don't need cookies since the recipient isn't
logged in yet, but include `credentials: "include"` anyway for
consistency.

**Note on the original Figma brief**: a couple of things it speculated on
don't match what's actually implemented — most importantly, acceptance is
**two separate endpoints** (`/accept` for new users, `/accept-existing`
for people who already have an account), not one endpoint with optional
auth. Build against the contract below, not the brief's guessed shapes.

## 1. Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/v1/invitations` | admin/manager | Send an invitation |
| `GET` | `/api/v1/invitations` | admin/manager | List invitations (Team page) |
| `GET` | `/api/v1/invitations/:id` | admin/manager | Single invitation |
| `PATCH` | `/api/v1/invitations/:id` | admin/manager | Edit while pending |
| `POST` | `/api/v1/invitations/:id/resend` | admin/manager | New link, old one dies |
| `PATCH` | `/api/v1/invitations/:id/revoke` | admin/manager | Cancel |
| `GET` | `/api/v1/invitations/validate?token=` | public | Accept-invite page loads this first |
| `POST` | `/api/v1/invitations/accept` | public | New user creates account + accepts |
| `POST` | `/api/v1/invitations/accept-existing` | authenticated | Existing user (already logged in) accepts |

A manager can invite `role: "worker"` but gets `403` inviting
`role: "manager"` — surface that as a normal permission error, don't hide
the "Manager" option from managers client-side only (the backend enforces
it regardless).

## 2. Create invitation

```js
async function sendInvitation(payload) {
  const res = await fetch(`${API_BASE_URL}/api/v1/invitations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw { status: res.status, ...data };
  return data;
}
```

Payload:

```json
{
  "email": "john@example.com",
  "role": "worker",
  "fullname": "John Smith",
  "phone": "+44...",
  "payRate": 13.5,
  "employeeId": "CLN-104",
  "sites": ["siteId1"]
}
```

Only `email` and `role` are required. **`sites` is accepted and stored,
but there's no `Site` model in this backend yet** — no cross-checking
against a sites collection happens, and nothing currently *uses* the
stored site ids for anything (no membership/access effect). If your Team
UI doesn't have real site data to offer, leave the sites field out of the
form entirely rather than building it against nothing.

Success: `201 { success: true, msg, invitation: {_id, email, fullname, role, status, expiresAt, createdAt} }`

Errors, all with a `code` field for branching UI copy:

| Status | code | Meaning |
|---|---|---|
| 409 | `ALREADY_MEMBER` | Email already belongs to a user in this company |
| 409 | `INVITATION_PENDING` | A pending invite already exists for this email |
| 403 | `INSUFFICIENT_PERMISSION` | Manager tried to invite a manager |
| 400 | `INVITATION_INVALID` | Bad email/role/payRate/site id |

Every error response is `{ msg, code }` — `msg` is safe to show directly,
`code` is for conditional UI (e.g. show "Resend invitation" only on
`INVITATION_PENDING`).

## 3. Team page — list

```js
GET /api/v1/invitations?status=pending&role=worker&search=john&page=1&limit=20
```

Response:

```json
{
  "success": true,
  "invitations": [
    {
      "_id": "...",
      "email": "john@example.com",
      "fullname": "John Smith",
      "role": "worker",
      "status": "pending",
      "expiresAt": "...",
      "createdAt": "...",
      "invitedBy": { "_id": "...", "fullname": "Sarah Jones" }
    }
  ],
  "totalInvitations": 2,
  "totalPages": 1,
  "currentPage": 1
}
```

`tokenHash` is never included (schema-level `select: false`) — don't
build any UI expecting to see or copy a raw token/link from this list.
The Figma brief's "Copy invitation link" row action **isn't supported** —
there's no endpoint that returns a usable link after creation; only the
email itself carries the raw token. Drop that action, or replace it with
"Resend" only.

Your Team page needs to merge this list with your existing active-members
list client-side (two separate collections, `Invitation` and `User`) —
there's no single "team" endpoint that combines both.

## 4. Resend / Revoke / Edit

```js
POST  /api/v1/invitations/:id/resend   // no body
PATCH /api/v1/invitations/:id/revoke   // no body
PATCH /api/v1/invitations/:id          // { fullname?, phone?, role?, sites?, payRate?, employeeId? }
```

- Resend only works on `pending` or `expired` invitations — `400
  INVITATION_NOT_PENDING` otherwise. It invalidates the previous link
  silently; no need to explain that in the UI.
- Revoke fails with `400 INVITATION_ACCEPTED` if already accepted.
- Edit only works while `pending` (`400 INVITATION_NOT_PENDING`
  otherwise) and does **not** allow changing `email` — there's no
  endpoint for that, matching the brief's own recommendation to prefer
  revoke + new invitation instead.

## 5. Accept-invite page (`/invite?token=...`)

On mount, before rendering anything else:

```js
async function validateInvitation(token) {
  const res = await fetch(
    `${API_BASE_URL}/api/v1/invitations/validate?token=${encodeURIComponent(token)}`,
    { credentials: "include" }
  );
  return res.json(); // always 200, even for expired/invalid — see below
}
```

This call is **always `200`**, including for expired/revoked/invalid
tokens — the "error" is encoded in the response body, not the HTTP
status, so the page can render a normal state rather than catching a
fetch error just to show what's actually an expected outcome:

```json
{ "success": true, "status": "pending", "invitation": { "...", "accountExists": false } }
```

`status` is one of `"pending" | "expired" | "revoked" | "accepted" | "invalid"`.
Route on it:

```
pending  + accountExists=false -> new-account form
pending  + accountExists=true  -> sign-in form
expired                        -> expired state, offer "ask for a new invite"
revoked                        -> revoked state
accepted                       -> "already used" state, link to sign in
invalid                        -> not-found state (missing/garbage token)
```

`invitation` is `null` only when `status === "invalid"`. Otherwise it has
`_id, company: {_id, name}, email, fullname, role, status, invitedBy: {_id, fullname}, expiresAt`
(plus `accountExists` only when `status === "pending"`).

Don't cache this response for later reuse (e.g. across page navigation)
— always re-validate right before submitting acceptance, since state can
change between load and submit (see §7).

## 6a. New-user acceptance

```js
async function acceptAsNewUser({ token, fullname, password }) {
  const res = await fetch(`${API_BASE_URL}/api/v1/invitations/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ token, fullname, password }),
  });
  const data = await res.json();
  if (!res.ok) throw { status: res.status, ...data };
  return data;
}
```

- `email`, `role`, and `company` are **never** taken from this request —
  they come from the invitation record server-side. Don't bother sending
  them; they're ignored even if you do.
- Password: minimum 8 characters, enforced server-side too
  (`INVITATION_INVALID` if shorter).
- On success (`201`), cookies are set exactly like a normal signup/login
  — the response is `{ success: true, user }`. **Redirect straight into
  the app**, no separate login step needed.
- `400 ACCOUNT_EXISTS` — an account was created for this email between
  validation and submission (race). Show a message and redirect to the
  sign-in form instead of retrying blindly.
- `400` with `INVITATION_EXPIRED` / `INVITATION_REVOKED` / `INVITATION_ACCEPTED`
  — the token changed state after validation (someone revoked it, it
  expired while the form was open, etc.). Send the user back to the
  relevant status state, don't just show a generic error toast.

## 6b. Existing-user acceptance

This one requires the user to actually be logged in first — two-step:

```js
// Step 1: normal login (existing endpoint, unrelated to invitations)
await fetch(`${API_BASE_URL}/api/v1/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  credentials: "include",
  body: JSON.stringify({ email, password }),
});

// Step 2: accept, now that a session exists
async function acceptAsExistingUser(token) {
  const res = await fetch(`${API_BASE_URL}/api/v1/invitations/accept-existing`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ token }),
  });
  const data = await res.json();
  if (!res.ok) throw { status: res.status, ...data };
  return data;
}
```

- `403 INVITATION_EMAIL_MISMATCH` — the logged-in account's email doesn't
  match the invitation's email. This means the person logged into the
  *wrong* account. Show something like "This invitation was sent to
  john@x.com, but you're signed in as someone else — sign out and sign
  in with the invited email," don't just show a raw error.
- `400 ALREADY_IN_ANOTHER_COMPANY` — this account already belongs to a
  *different* company on the platform. **This backend has no
  multi-company support** — an account can only ever belong to one
  company, ever. This is a hard stop, not a retryable error; there's no
  "switch companies" flow to offer.
- If the account is already a member of *this same* company (e.g.
  re-invited by mistake), the endpoint succeeds idempotently — treat it
  as a normal success, not an error.
- If Google sign-in is used for step 1, it works automatically — this
  endpoint doesn't care how the session was established, only that
  `req.user`'s email matches the invitation's email. (Note: Google
  *sign-up* — a brand-new account via Google as part of accepting an
  invite — isn't supported; this codebase's Google auth only logs in
  existing accounts.)

## 7. Race conditions to actually handle

The backend re-validates the full invitation state on every acceptance
call — it does not trust whatever `/validate` returned earlier. Build the
UI assuming any of these can happen between page load and form submit:

- Another tab/device already accepted it → `INVITATION_ACCEPTED`.
- A manager revoked it while the page was open → `INVITATION_REVOKED`.
- It simply expired while the form was open (7-day window, so unlikely
  mid-session, but the check exists) → `INVITATION_EXPIRED`.
- Someone else created an account for that email in the meantime (new-user
  path only) → `ACCOUNT_EXISTS`.

All of these arrive as normal `400`/`409` JSON error bodies with a `code`
— handle them by re-routing to the appropriate status state, not by
retrying the same request.

## 8. Error code reference

```
INVITATION_INVALID          400  malformed input
INVITATION_NOT_FOUND        404  unknown token / invitation id
INVITATION_EXPIRED          400
INVITATION_REVOKED          400
INVITATION_ACCEPTED         400  token already used
INVITATION_PENDING          409  duplicate pending invite (create only)
INVITATION_NOT_PENDING      400  edit/resend/revoke attempted in wrong state
ALREADY_MEMBER              409  email already active in this company
ACCOUNT_EXISTS              400  account created mid-race (new-user accept)
INVITATION_EMAIL_MISMATCH   403  wrong logged-in account (existing-user accept)
ALREADY_IN_ANOTHER_COMPANY  400  account belongs to a different company
INSUFFICIENT_PERMISSION     403  manager tried to invite/edit-to a manager
```

## 9. Testing checklist

- Admin invites a worker → email arrives, link works, account created,
  auto-logged-in, lands in the app.
- Manager tries to invite a manager → `403 INSUFFICIENT_PERMISSION`.
- Invite the same email twice while the first is still pending → `409
  INVITATION_PENDING`.
- Invite someone already an active member → `409 ALREADY_MEMBER`.
- Resend → old link now returns `status: "invalid"` from `/validate`,
  new link works.
- Revoke a pending invite → link now returns `status: "revoked"`.
- Let an invite sit unused past `expiresAt` → `/validate` returns
  `status: "expired"` (don't rely on a specific duration in tests; it's
  currently 7 days).
- Existing user (already has an account) opens the link → `/validate`
  returns `accountExists: true` → sign-in form → accept-existing
  succeeds and shows them in the company's Team list.
- Log in as User A, then try to accept an invitation sent to User B's
  email → `403 INVITATION_EMAIL_MISMATCH`.
- Try accepting the same token twice in a row → second attempt gets
  `INVITATION_ACCEPTED`.
