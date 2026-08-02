# AutoOps

A modern AI workflow automation platform.

## Vision

AutoOps allows users to create AI-powered routines that can execute automatically.

The goal is to eliminate repetitive AI work.

## Architecture

AutoOps is a **multi-tenant** application. Every signed-in Google account is a
tenant, and data is scoped to its owner:

- A **Worker** belongs to a User.
- A **Run History** entry belongs to a User, inherited from the worker that
  produced it.

Every read is filtered by the session's user id, and ownership is enforced on
the server. Requesting another tenant's worker or run returns **404** rather
than 403, so the existence of a record is never disclosed.

The **Scheduler** and **Dispatcher** are the deliberate exception: they run
system-wide across all tenants, because scheduled execution is triggered by the
platform rather than by a signed-in user.

### Tenant Identity

**The tenant key is the Google account id** — `account.providerAccountId`, which
is the OIDC `sub`. It is stored as `User.id`, and `token.sub` is set from it in
the `jwt` callback.

**Never key tenancy on `user.id`.** With no database adapter configured, Auth.js
v5 mints a fresh UUID for `user.id` on every sign-in. It looks like a stable
identifier and is not one. Using it means:

- every sign-in is treated as a new tenant, so the account's own workers vanish;
- creating the first worker fails on the unique constraint on `email`, because
  the upsert matches an id that no longer exists.

`account` is only present on the sign-in that issues the token; later calls
carry the value forward in `token.sub`, so the check is guarded rather than
unconditional.

This rule outlives any single auth change. Adding a provider, introducing an
adapter, or reworking session handling must keep the tenant key **stable for the
life of the account** and derived from the provider, not from a value the
framework generates per session. A second provider needs its own mapping to a
stable id — reusing this one is not automatically correct, because two providers
can return different ids for the same person.

### Worker Lifecycle

A worker is created from the dashboard and managed from its **detail page**,
which is the hub for everything you can do to it:

```
Hire  →  Worker Detail  →  Run (manual or scheduled)  →  Activity  →  Execution Detail
             │
             ├─→  Edit
             └─→  Danger zone: Delete
```

The card in **My Workers** links to `/dashboard/workers/[id]`. Reading and
editing are deliberately separate: the detail page shows everything including
the fields no form should expose (`Created At`, `Updated At`, `Last Run`), while
`/dashboard/workers/[id]/edit` covers only what can change — name, description,
prompt, frequency, and status. Saving an edit returns to the detail page.

Every step is scoped to the owner — touching someone else's worker returns
**404**, and the owner is read from the session, never from the form.

**Deleting** lives in the **Danger zone** at the bottom of the detail page. It
asks for confirmation, then removes the worker together with its run history
(the schema cascades). There is no archive or restore: deletion is permanent.

Delete is *not* on the edit page, and this is structural rather than cosmetic. A
server action re-renders the page it was called from; an edit page built around
the worker it just deleted looks it up again, finds nothing, and 404s before the
success notification can appear. Deleting from the detail page navigates away
first, and deleting anywhere else must do the same.

Changing the **frequency** resets the pending slot, because the old one no
longer describes the new cadence: switching to `manual` clears `nextRunAt` so
the worker stops being due, and switching away from it schedules the first slot.
Leaving the frequency alone keeps the existing slot, so editing a name or prompt
never shifts the schedule.

Changing the **status** to `paused` or `draft` takes the worker out of scheduled
execution without discarding its schedule.

**Frequency is the only cadence a worker has.** The label shown on the card and
the detail page — "Every day", "Manual execution" — is generated from it rather
than stored. There used to be a free-text `schedule` field beside it, which
meant a worker running daily could describe itself as weekly and nothing would
object. Deriving the label removes that possibility.

What frequency cannot express is a **time of day**: `nextRunAt` advances from
whenever the worker was saved, so a daily worker created at 15:30 runs at 15:30.
The label says how often, never when, because claiming otherwise would be the
same mismatch in a new place.

### Dashboard

The dashboard has three sections, in this order:

```
Dashboard  (/dashboard)
├─ Overview     — five summary cards
├─ My Workers   — one card per worker, each linking to its detail page
└─ Activity     — recent runs, each linking to its execution detail
```

**Overview** answers "what is the state of the workforce" without opening
anything: Total Workers, Active Workers, Paused Workers, Next Scheduled Run, and
Last Execution.

`Next Scheduled Run` considers **active workers only**. Paused and draft workers
keep a `nextRunAt`, but the scheduler ignores them, so counting them would
advertise a run that never happens.

The summaries are a fold over rows the page already loads, not a second set of
queries. The dashboard reads workers and run history once each, and neither the
number of cards nor the number of summaries changes that.

### Notification System

Actions report their outcome through a **toast** in the top-right corner, which
dismisses itself after five seconds.

Server actions return an `ActionResult` (`{ status, message }`) rather than
redirecting. The client raises the toast and then navigates, so a create,
update, or delete can report success *and* land the user somewhere else in the
same interaction.

The **URL parameter approach is gone**. Success used to travel as a query string
(`?deleted=1`), which meant a reload replayed a notification for something that
happened minutes earlier. Nothing is persisted now: a reload clears the toasts,
which is the correct behaviour for a transient message.

The provider lives in the root layout, so toasts survive client-side navigation.
One consequence is worth knowing: a component that unmounts on success — a card
that deletes itself — cannot raise its toast from an effect, because the effect
never runs. Those call sites raise it from the action's result directly.

### Worker Health

Cards and the detail page both show a **Health** section, rendered from the same
summary so the two never disagree:

| Field | Meaning |
| --- | --- |
| **Last Run Result** | `Success`, `Failed`, `Running`, or `Never run` |
| **Last Run Time** | When the most recent run started |
| **Total Runs** | Every run recorded for the worker |
| **Total Failures** | How many of those failed |

A run that throws is recorded as `failed` rather than left at `running`, which
is what makes the failure count meaningful. The manual run action reads the
recorded status: a failure that was caught and stored is still a failure, and is
reported as one.

The dashboard derives health for every worker from the run history it already
loaded, in a single pass. The number of cards never drives the number of
queries.

### Scheduling Engine

Scheduled execution is split across three modules, each with one job:

| Module | Responsibility |
| --- | --- |
| **Scheduler** (`lib/scheduler.ts`) | Decides *what* is due. Read-only — it never writes. |
| **Schedule** (`lib/schedule.ts`) | Computes *when* the next slot falls. Pure arithmetic, no database access. |
| **Dispatcher** (`lib/dispatcher.ts`) | Owns the hand-off: enqueues each due worker, then writes the new `nextRunAt`. |

Two rules govern the update:

- **`nextRunAt` advances from the stored value, never from the clock.** A worker
  due at 09:00 that a cron tick picks up at 09:05 is next due at 09:00 the
  following day. Late ticks cannot drag the schedule forward.
- **The schedule advances only after the queue accepted the worker.** A failed
  run leaves `nextRunAt` untouched, so the slot is retried rather than skipped.

Workers with `manual` frequency keep `nextRunAt` as `null` and are never due.

## Features

### Current

**Accounts**

- Google Authentication (Auth.js v5, JWT sessions)
- Multi-tenancy — every row scoped to its owner, 404 on someone else's

**Workers**

- Worker CRUD — hire, edit, delete
- Worker Detail — read-only hub for one worker
- Worker Templates — start from a preset instead of a blank form
- Prompt Variables — `{{date}}` and friends, rendered per run
- Worker Health — last result, run and failure totals

**Dashboard**

- Dashboard Overview — five summary cards
- Notification System — toast notifications
- Activity — recent runs
- Execution Detail — one run, with its output

**Execution**

- Manual Run
- Scheduler — decides what is due
- Dispatcher — hands off due workers and advances the schedule
- Queue — the hand-off boundary, inline for now
- Cron API — `POST /api/cron/run`
- Claude Provider — real AI execution when `ANTHROPIC_API_KEY` is set
- Run History — every execution, with status and output

**Storage**

- SQLite + Prisma

### Planned

- Multiple AI Providers
- Team Workspaces
- Email and Webhook notifications
- Real queue backend (the current one runs inline)

## Tech Stack

- Next.js 15
- TypeScript
- Tailwind CSS
- shadcn/ui
- Prisma
- SQLite

## Development

```bash
pnpm install
pnpm dev
pnpm lint
pnpm build
```

## Setup

`.env.example` lists every variable AutoOps reads. Copy it to `.env`, then fill
in the values:

```bash
cp .env.example .env
```

```
ANTHROPIC_API_KEY=sk-ant-...
AUTH_SECRET=...
AUTH_GOOGLE_ID=...
AUTH_GOOGLE_SECRET=...
CRON_SECRET=...
```

`.env` is gitignored; `.env.example` is committed and holds no real values.

When `ANTHROPIC_API_KEY` is set, workers run against the Claude API. Without it,
AutoOps falls back to a stand-in provider that returns a fixed response — no key
is required to run the app locally.

### Cron API

`POST /api/cron/run` is the entry point for scheduled execution. It asks the
dispatcher to run every worker that is due and reports how many it handed off.
It is provider-agnostic — Vercel Cron, Cloudflare Cron, GitHub Actions, and
Trigger.dev can all call it.

- **`POST` only.** Other methods return `405`.
- **`Authorization: Bearer <CRON_SECRET>` is required.** The header is matched
  against `CRON_SECRET`; anything else returns `401`. With `CRON_SECRET` unset
  the endpoint rejects every request, so a missing variable can never leave it
  open.

```bash
curl -X POST http://localhost:3000/api/cron/run \
  -H "Authorization: Bearer $CRON_SECRET"
```

Success (`200`) — `dispatched` is the number of workers handed to the queue:

```json
{ "success": true, "dispatched": 3 }
```

Nothing due (`200`):

```json
{ "success": true, "dispatched": 0 }
```

Missing or wrong secret (`401`):

```json
{ "success": false, "error": "Unauthorized" }
```

Failure (`500`) — the cause is written to the server log only:

```json
{ "success": false, "error": "Internal Server Error" }
```

### Authentication

The dashboard is behind Google sign-in (Auth.js v5, JWT sessions). All three
`AUTH_*` variables are required to sign in.

Generate a session secret:

```bash
pnpm dlx auth secret
```

Create a Google OAuth client in the
[Google Cloud Console](https://console.cloud.google.com/apis/credentials)
(Application type: Web application) and copy the client ID and secret into
`AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`. Add this authorized redirect URI:

```
http://localhost:3000/api/auth/callback/google
```

For production, add the same path on your deployed origin.

## Roadmap

| Sprint | Delivered | Status |
| --- | --- | --- |
| Sprint 1 | Project setup, dashboard, persistence | Completed |
| Sprint 2 | Manual execution, AI provider abstraction, scheduling metadata, queue | Completed |
| Sprint 3 | Worker terminology, templates, prompt variables, Claude API | Completed |
| Sprint 4 | Execution detail, scheduler, dispatcher | Completed |
| Sprint 5 | Google authentication, multi-tenancy | Completed |
| Sprint 6 | Cron entry point, scheduling engine | Completed |
| Sprint 7 | Worker edit and delete | Completed |
| Sprint 8 | Toast notifications, worker detail, dashboard overview | Completed |
| Sprint 9 | Worker health (Day 1) | In Progress |

## Backlog

Known and deliberately deferred — none of these are bugs waiting on a fix.

**UI**

- Character counters — a field only reports being over its limit after the form
  is submitted
- Scrolling to the first error — on a long form the field at fault can be off
  screen when the toast appears

**Scheduling**

- **A time of day.** `frequency` says how often, never when: `nextRunAt`
  advances from whenever the worker was saved, so a daily worker created at
  15:30 runs at 15:30 forever. The free-text `schedule` field used to paper
  over this, and its removal makes the gap plain rather than creating it.
  Closing it means extending `frequency` with the fields that carry a time,
  which also raises time zones — every timestamp in the UI is currently UTC.
  The `schedule` column stays in the schema until then: that work either drops
  it or replaces it, and one migration is better than two.
- Catch-up strategy after a long outage — currently every missed slot is
  retried one at a time; skipping to the next future slot, or capping the
  number of catch-up runs, are the alternatives
- Month-end schedules — a monthly worker due on the 31st does not hold that
  position through shorter months
- Making the run and the `nextRunAt` update atomic — needs a transactional
  backend, so it is deferred to the Redis/PostgreSQL migration

**Concurrency**

- Optimistic locking — two tabs editing the same worker currently last-write-wins

**Operational**

- `削除用/dev.db.bak` — the database from before the tenant identity fix, kept
  until Closed Beta starts
