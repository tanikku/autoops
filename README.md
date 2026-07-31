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

### Worker Lifecycle

A worker is created from the dashboard, edited in place, and runs either on its
schedule or on demand:

```
Hire  →  Edit  →  Run (manual or scheduled)  →  Activity  →  Execution Detail
                     │
                     └─→  Delete
```

Editing (`/dashboard/workers/[id]/edit`) covers name, prompt, frequency, and
status, and is also where a worker is deleted. Every step is scoped to the
owner — touching someone else's worker returns **404**, and the owner is read
from the session, never from the form.

**Deleting** asks for confirmation, then removes the worker together with its
run history (the schema cascades). There is no archive or restore: deletion is
permanent.

Changing the **frequency** resets the pending slot, because the old one no
longer describes the new cadence: switching to `manual` clears `nextRunAt` so
the worker stops being due, and switching away from it schedules the first slot.
Leaving the frequency alone keeps the existing slot, so editing a name or prompt
never shifts the schedule.

Changing the **status** to `paused` or `draft` takes the worker out of scheduled
execution without discarding its schedule.

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

- Dashboard
- Routine Management
- SQLite + Prisma
- Manual Execution
- Run History
- Scheduling Metadata
- AI Provider Abstraction

### Planned

- Claude API Integration
- Automatic Scheduler
- Multiple AI Providers
- Team Workspaces
- Notifications

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

| Sprint | Status |
| --- | --- |
| Sprint 1 | Completed |
| Sprint 2 | In Progress |
