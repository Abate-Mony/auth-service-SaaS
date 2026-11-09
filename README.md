# OnClockly — Backend API

OnClockly (formerly INPRN) is a multi-tenant workforce management platform:
scheduling, time tracking, client bookings, quoting, invoicing, and
notifications for companies that manage shift-based workers.

This repository is the **backend only** — a single Node/Express/MongoDB API.
There is no frontend in this repo; it's consumed by several separate
applications:

| App | Repo | Who it's for |
|---|---|---|
| `work.wk` | web dashboard | Admins / managers — scheduling, invoicing, clients, settings |
| `timeshift-mobile` | Expo app | Workers — clock in/out, schedule, timesheets |
| `client-mobile` | Expo app | Clients — bookings, quotes, invoices |
| `client_portal_onclockly` | web | Browser-based client portal (no app install) |
| `quote.xeniapure.com` | web | Public quote intake / estimate requests |
| `saas-marketing-app` | web | Public marketing site |

CORS in `src/server.ts` is the source of truth for which origins are
currently allowed to call this API.

---

## Tech Stack

- **Runtime**: Node.js, TypeScript, Express 4
- **Database**: MongoDB via Mongoose
- **Auth**: JWT (access + refresh), HTTP-only cookies for the web dashboard, Bearer tokens for mobile, Google OAuth
- **Validation**: Zod
- **Email**: Resend (primary) / Nodemailer
- **Push**: Expo Server SDK (mobile), Web Push/VAPID (browser)
- **Billing**: Stripe (subscriptions) + a self-built client-invoicing engine (`services/invoice/`)
- **AI**: Anthropic SDK — dashboard insights and AI-assisted job drafting (`services/ai/`)
- **Files**: Cloudinary (images/logos), PDFKit (generated invoice PDFs)
- **Scheduling**: node-cron for all background jobs (see below)
- **Testing**: Node's built-in test runner (`node --test`)

---

## Project Structure

```
src/
  controllers/   Route handlers — one file per domain (jobs, workers, invoices, ...)
  routes/        Express routers, mounted in server.ts
  models/        Mongoose schemas
  middleware/    Auth, tenant restriction, company-status gating, error handling
  services/      Business logic that's more than a CRUD handler
    ai/            Claude-powered dashboard insights + job-draft assistant
    invoice/       Invoice calculation, eligibility, draft/deposit/recurring generation
    quote/         Lead → quote conversion
    quoteWorkflow/ Quote pricing estimation
  utils/         Shared helpers (notifications, email templates, date/time, auto clock-out, ...)
  scripts/       One-off/maintenance scripts — migrations, platform admin, cleanup (see package.json)
  interface(s)/  Shared TypeScript types
  db/            Mongo connection setup
tests/           node --test suites (*.test.cjs)
```

---

## Getting Started

```bash
git clone https://github.com/Abate-Mony/auth-service-SaaS.git
cd auth-service-SaaS
npm install
```

Set up your `.env` — see [ENVIRONMENT.md](./ENVIRONMENT.md). At minimum you'll need:

- `MONGO_URI`, `JWT_SECRET`, `PORT`
- `CLIENT_URL` / `CLIENT_PORTAL_URL` / `PUBLIC_QUOTE_URL` (which frontends this instance talks to)
- `RESEND_API_KEY`, `EMAIL_FROM` / `MAIL_*` (transactional email)
- `CLOUDINARY_URL` (file uploads)
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_PRICE_*` (subscription billing)
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` (web push)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` (Google OAuth)
- `ANTHROPIC_API_KEY` (AI dashboard insights / job drafting)

### Run

```bash
npm run dev     # tsc -w + nodemon, recompiles and restarts on change
npm run build   # tsc -> dist/
npm start        # node dist/server.js (production)
```

### Test

```bash
npm test
```

Runs `tests/*.test.cjs` — quote expiry, session token selection, booking
notifications, and auto clock-out (lease concurrency, timestamp validation,
break handling).

---

## Background Jobs

All scheduled via `node-cron` in `src/server.ts`:

| Schedule | Job | Purpose |
|---|---|---|
| Every minute | `sendUpcomingShiftReminders` | Upcoming-shift push/email reminders |
| Every minute | `autoCloseAbandonedShifts` | Force-closes shifts left open past their deadline (lease-based, race-safe) |
| Every minute | `markMissedShifts` | Flags shifts nobody clocked into |
| Daily 01:00 UTC | `runDailyOccurrenceGeneration` | Generates upcoming occurrences of recurring jobs |
| Daily 06:00 UTC | `generateRecurringInvoices` | Drafts invoices for recurring billing |
| Daily 08:00 UTC | `sendOverduePaymentReminders` | Chases unpaid invoices |
| Daily 02:00 UTC | `expireTrials` | Reverts expired free trials to the free plan |
| Hourly | `sendStaleQuoteRequestReminders` | Nudges on quotes unanswered 24h+ |
| Every 10 min | `checkPendingEmailDomains` | Polls DNS for custom sending-domain verification |

---

## API Surface

Base path: `/api/v1`. Most routes require `authenticateUser` +
tenant-scoping middleware (`loadRestriction`, `enforceCompanyStatus`); a few
are intentionally public or use a different auth scheme — noted below.

| Mount | Domain |
|---|---|
| `/auth` | Staff login/signup/refresh |
| `/client-auth` | Client-portal auth (separate from staff auth) |
| `/portal` | Client portal — bookings, quotes, invoices, reviews (mixed public/authenticated) |
| `/users` | User/account management |
| `/jobs` | Job scheduling and lifecycle |
| `/workers` | Clock in/out, breaks, timesheets, overtime review, worker-facing job actions |
| `/time-off` | Time-off requests |
| `/booking-requests` | Client-submitted booking requests |
| `/job-change-requests` | Worker-requested shift changes |
| `/notification-preferences`, `/notifications` | Per-user notification settings + inbox |
| `/availability` | Worker availability |
| `/activity-logs` | Audit trail |
| `/companies` | Company profile, settings, plan |
| `/timesheets` | Timesheet views/exports |
| `/calendar` | Calendar views |
| `/invitations` | Team invites (public validate/accept + authenticated) |
| `/recurring-jobs` | Recurring job schedules |
| `/clients`, `/leads`, `/sites` | CRM-style entities |
| `/invoices`, `/invoice-templates` | Client invoicing |
| `/quotes` | Quotes (mixed public view/respond + authenticated) |
| `/public/quote-intake` | Fully public quote intake (resolves company by slug) |
| `/restrictions` | Account restriction status/appeals |
| `/analytics`, `/reports` | Dashboard insights and reports |
| `/ai` | AI dashboard insights + job-draft assistant |
| `/documents` | Worker document uploads |
| `/external` | API-key authenticated — third-party integrations, see [EXTERNAL_API.md](./EXTERNAL_API.md) |
| `/platform` | OnClockly staff/platform admin (own auth boundary, not company-scoped) |
| `POST /stripe/webhook` | Stripe webhook (raw body, signature-verified, unauthenticated by design) |
| `GET /plans` | Public plan catalog |
| `GET /health` | Unauthenticated health check |

See [EXTERNAL_API.md](./EXTERNAL_API.md) for the separate API-key-based
integration surface, and the `FRONTEND_*.md` files for the design notes
behind specific features (invitations, recurring jobs, push notifications,
password reset, client management).

---

## Roles

- **Owner / Admin** — full company access
- **Manager** — scheduling, worker management, client/invoice access (scope mirrors admin in most places; see individual route guards)
- **Worker** — own schedule, clock in/out, timesheets, profile
- **Client** (portal, separate auth) — own bookings, quotes, invoices, reviews
- **Platform roles** (`super_admin`, `support_admin`, `billing_admin`) — OnClockly's own staff, cross-tenant, via `/platform`

---

## License

Private project — © OnClockly
