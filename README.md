# AutoOps

A modern AI workflow automation platform.

## Vision

AutoOps allows users to create AI-powered routines that can execute automatically.

The goal is to eliminate repetitive AI work.

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
```

`.env` is gitignored; `.env.example` is committed and holds no real values.

When `ANTHROPIC_API_KEY` is set, workers run against the Claude API. Without it,
AutoOps falls back to a stand-in provider that returns a fixed response — no key
is required to run the app locally.

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
