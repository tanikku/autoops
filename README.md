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
