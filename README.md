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

Copy `.env.example` to `.env` and set your Anthropic API key:

```bash
cp .env.example .env
```

```
ANTHROPIC_API_KEY=sk-ant-...
```

When `ANTHROPIC_API_KEY` is set, workers run against the Claude API. Without it,
AutoOps falls back to a stand-in provider that returns a fixed response — no key
is required to run the app locally.

## Roadmap

| Sprint | Status |
| --- | --- |
| Sprint 1 | Completed |
| Sprint 2 | In Progress |
