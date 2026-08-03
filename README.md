# AutoOps

A modern AI workflow automation platform.

## Vision

Build your AI workforce. Define a **worker** once — a name, a prompt, a cadence
— and let it run on schedule or on demand.

The goal is to eliminate repetitive AI work: the prompt you retype every morning
should be a worker instead.

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

### Execution Pipeline

Two paths reach the same queue. A manual run starts from a button; a scheduled
run starts from a cron tick. Neither knows about the other.

```
Manual                          Scheduled
  │                                │
  │                          Scheduler ── decides what is due
  │                                │
  │                          Dispatcher ── hands off, then advances nextRunAt
  │                                │
  └────────────► Queue ◄───────────┘
                   │
             Prompt Rendering ── {{today}}, {{now}}
                   │
              AI Provider ── Claude, or a stand-in without a key
                   │
              RunHistory ── status, output, timings
```

Each module does one thing, and the boundaries are deliberate:

| Module | Owns | Does not |
| --- | --- | --- |
| `lib/scheduler.ts` | Deciding *what* is due | Write anything. It is read-only |
| `lib/schedule.ts` | Computing *when* the next slot falls | Touch the database. Pure arithmetic |
| `lib/dispatcher.ts` | The hand-off, and advancing `nextRunAt` | Decide what is due, or run anything itself |
| `lib/queue.ts` | Being the boundary a run crosses | Anything else — it runs inline for now |
| `lib/prompt.ts` | Substituting `{{variables}}` | Know where the prompt came from |
| `lib/ai/*` | Talking to a model | Know about workers, users or schedules |
| `lib/runs.ts` | Recording what happened | Decide when to run |

**Templates** (`lib/worker-templates.ts`) sit outside this pipeline entirely.
They are starting values for the create form — a name, a prompt, a frequency —
and nothing reads them after a worker exists.

The queue exists as a seam rather than an implementation. Swapping the inline
call for a real backend should not require changes above or below it.

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

### Frequency and the schedule column

**Frequency is the only cadence a worker has.** The label on the card —
"Every day", "Manual execution" — is generated by `lib/schedule-label.ts` rather
than stored.

There used to be a free-text `schedule` field beside it, typed by the user and
reconciled with nothing. A worker running daily could describe itself as weekly
and the app would show the lie on the card. Generating the label from the one
value the dispatcher acts on removes that possibility.

The detail page shows **Frequency** and no Schedule row: restating the same
value in other words is what caused the problem in the first place. The card
carries the phrased version, being the only view without a Frequency row.

**`Routine.schedule` remains in the schema.** It is not written, not displayed,
and not read for anything — but the column stays until the scheduler gains a
time of day. That work either drops it or replaces it with the fields carrying a
time, and one migration then is better than one now and another later.

What frequency cannot express is exactly that **time of day**: `nextRunAt`
advances from whenever the worker was saved, so a daily worker created at 15:30
runs at 15:30 forever. The label says how often, never when, because claiming
otherwise would be the same mismatch in a new place.

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

### Form Architecture

Hiring a worker and editing one are the same form with different defaults. That
is enforced structurally, not by convention:

| Piece | Responsibility |
| --- | --- |
| `components/worker-fields.tsx` | Renders every editable field. Displays validation; never performs it |
| `lib/worker-input.ts` | Reads FormData, trims, narrows enums, and decides what is valid |
| `workerFieldLimits` | The length ceilings, defined once |
| `validateWorkerForm` | The only place a rule lives. Both actions call it and neither adds checks of its own |

Both forms render the same component and both actions call the same parser, so
**a field cannot exist on one side and be missing from the other.** That is not
hypothetical: Description and Schedule were once creatable but not editable,
because each form carried its own copy of the markup.

The two actions differ in exactly one place, and it is explicit: an unreadable
`status` or `frequency` falls back to `draft` / `manual` when creating, and to
the worker's existing value when editing. A new worker starts quiet; an existing
one is not silently reset.

Fields stay **uncontrolled**. The form submits through a server action that
reads FormData, so no component holds the values. Two consequences follow:

- **A rejected submission carries its input back.** React resets a form once its
  action settles, so the action returns what was typed and the form uses it as
  the new defaults. Without this, a missing name would discard a long prompt.
- **Forms remount on submit.** `defaultValue` is read once at initialisation;
  feeding values back through it on a re-render changes it after the fact, which
  Base UI rejects. Remounting makes it a fresh initialisation instead.

### Validation UX

A rejected submission reports itself three ways, each doing something the others
cannot:

| Signal | Says |
| --- | --- |
| **Toast** | That something is wrong — one message, or "N fields need attention" |
| **Field message** | What is wrong with *this* field, below the input, with the border turned red |
| **Auto-scroll and focus** | *Where* — the first rejected field is brought to centre and focused |

"First" means topmost, taken from the render order rather than whichever the
validator recorded first.

Each limited field also carries a **character counter** beside its label,
reading its ceiling from `workerFieldLimits` — the same constant
`validateWorkerForm` checks. The counter cannot promise a bound the server does
not enforce. Going over turns it red and is still rejected on submit.

**Nothing truncates as you type.** There is no `maxLength`, deliberately:
cutting at a limit during IME composition drops characters the user has not
finished choosing. Going over is allowed, shown, and rejected at the boundary
that matters.

For screen readers, the input points at both its message and its counter through
`aria-describedby`, so the reason and the length are read together rather than
one replacing the other.

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
- Prompt Variables — `{{today}}` and `{{now}}`, substituted per run
- Worker Health — last result, run and failure totals

**Forms**

- Shared field definitions — create and edit cannot drift apart
- Length validation — one set of limits, checked server-side
- Per-field error messages, character counters, and auto-scroll to the first
  rejected field

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

| Layer | Choice | Notes |
| --- | --- | --- |
| Framework | **Next.js 15** (App Router) | Server Components by default |
| Language | **TypeScript** | |
| Mutations | **Server Actions** | No REST layer for the dashboard; the only HTTP endpoints are auth and cron |
| Auth | **Auth.js v5** + **Google OAuth** | JWT sessions, no database adapter — see [Tenant Identity](#tenant-identity) |
| Database | **SQLite** + **Prisma 7** | Prisma 7 requires a driver adapter (`@prisma/adapter-better-sqlite3`) |
| Styling | **Tailwind CSS v4** | Theme tokens in `app/globals.css` |
| Components | **shadcn/ui** (Base UI) | Note: Base UI, not Radix — buttons take `render`, not `asChild` |
| Icons | **lucide-react** | |
| AI | **Anthropic SDK** | Behind a provider interface; falls back to a stand-in without an API key |

Two details bite anyone who assumes the usual defaults:

- **shadcn/ui here is built on Base UI.** A `<Button>` rendered as a link needs
  `render={<Link/>}` *and* `nativeButton={false}`; `asChild` does not exist.
- **Prisma 7 needs a driver adapter.** `lib/prisma.ts` constructs one; a plain
  `new PrismaClient()` will not connect.

## Data Model

Three tables. Every owned row carries `userId` so a query can be scoped without
a join, and both relations cascade on delete.

```
User ──┬── Routine ──── RunHistory
       └── RunHistory
```

| Model | Purpose | Key points |
| --- | --- | --- |
| **User** | A signed-in Google account | `id` is the provider account id, not a generated key |
| **Routine** | A worker | `frequency` drives execution; `nextRunAt` is the pending slot |
| **RunHistory** | One execution | `userId` denormalised from the routine |

**Deleting a User removes its routines and runs. Deleting a Routine removes its
runs.** Both are `onDelete: Cascade` in the schema, which is why deleting a
worker needs no cleanup code.

`status` and `frequency` are plain strings in SQLite, so `lib/routines.ts`
narrows them at the boundary and falls back to `draft` / `manual` on anything
unrecognised. The same applies to `RunHistory.status`.

`Routine.schedule` still exists but is neither written nor displayed — see
[Frequency and the schedule column](#frequency-and-the-schedule-column).

## Development

```bash
pnpm install
pnpm dev                    # http://localhost:3000
pnpm lint
pnpm exec tsc --noEmit      # types; `pnpm build` also checks them
pnpm build
```

Database:

```bash
pnpm exec prisma migrate dev      # create and apply a migration
pnpm exec prisma migrate deploy   # apply existing migrations
pnpm exec prisma studio           # browse the data
```

`pnpm build` while `pnpm dev` is running corrupts `.next` and the app starts
serving broken chunks. Stop the dev server first; if it already happened,
`rm -rf .next` and restart.

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

### Prompt Variables

A prompt may contain `{{name}}` placeholders, substituted at the moment of each
run:

| Variable | Becomes | Example |
| --- | --- | --- |
| `{{today}}` | The date, ISO 8601 | `2026-08-03` |
| `{{now}}` | The full timestamp, ISO 8601 | `2026-08-03T00:17:38.000Z` |

Both are UTC. **An unknown name is left in place** rather than replaced with an
empty string, so a typo shows up in the output instead of silently vanishing.

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

The dashboard is behind Google sign-in (**Auth.js v5**, JWT sessions, **no
database adapter**). All three `AUTH_*` variables are required to sign in.

Skipping the adapter is deliberate: `auth.ts` stays free of database imports, so
the middleware protecting `/dashboard/*` runs on the edge without a round trip.
The cost is that nothing writes the `User` row at sign-in, so `ensureUser()`
creates it lazily before the first row that references it.

That same choice is why the tenant key comes from `account.providerAccountId` —
see [Tenant Identity](#tenant-identity) before touching anything in `auth.ts`.

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
| Sprint 9 | Worker health, toast visibility, complete worker edit, length validation | Completed |
| Sprint 10 | Schedule derived from frequency, character counters, scroll to first error | Completed |
| Sprint 11 | Documentation sync | In Progress |

## Backlog

Known and deliberately deferred — none of these are bugs waiting on a fix.

**Blocking**

- **A way to set your timezone.** `User.timezone` decides both what timestamps
  read as and, since workers gained a time of day, *when they actually run* —
  and the only way to change it is editing the database by hand. Everyone is on
  UTC, so "09:00" means 18:00 in Tokyo. The Settings link exists in the nav and
  is disabled. This was a nice-to-have while the column only affected display;
  it stopped being one when it started affecting execution.

**Scheduling**

- **A day of the week, and a day of the month.** A worker can pick the time it
  runs but not which day: a weekly worker keeps the weekday it was saved on,
  and a monthly one keeps the date. `runAtWeekday` and `runAtDay` alongside
  `runAtMinutes` would close this, in the same shape.
- Catch-up strategy after a long outage — currently every missed slot is
  retried one at a time; skipping to the next future slot, or capping the
  number of catch-up runs, are the alternatives
- Month-end schedules — a monthly worker due on the 31st does not hold that
  position through shorter months
- Making the run and the `nextRunAt` update atomic — needs a transactional
  backend, so it is deferred to the Redis/PostgreSQL migration

**Design debt**

- **`lib/schedule.ts` reads from the database.** `advanceNextRunAt` looks up the
  owner's timezone, so the module the architecture section calls pure
  arithmetic is not, and the schedule layer has taken on a repository's job.
  The arithmetic itself stayed pure and separately testable, which is why this
  was accepted rather than fixed: separating it properly reaches into the
  dispatcher and the repository boundary at once, which is more than the sprint
  that introduced it was scoped for.
- **The architecture section above says otherwise.** It still describes
  `lib/schedule.ts` as touching no database. Correct it when the split lands,
  or correct it sooner if the split does not.

**Concurrency**

- Optimistic locking — two tabs editing the same worker currently last-write-wins

**Operational**

- **Deployment.** AutoOps has only ever run locally, so there is no deployment
  section above and this entry deliberately does not invent one — what follows
  is the list of decisions still open, not a plan. Needed before Closed Beta:

  | Decision | Open question |
  | --- | --- |
  | Hosting platform | Where the app runs, and whether its runtime supports the Node APIs the driver adapter needs |
  | Environment variables | Where each of the five is set, and who holds the values |
  | `CRON_SECRET` | How the secret reaches both the app and whatever calls the cron endpoint |
  | Database hosting | SQLite on a persistent disk, or a hosted database — most platforms have ephemeral filesystems, which SQLite does not survive |
  | SQLite migration path | Whether to move to PostgreSQL before Beta or after, and how existing rows travel |
  | Cron execution | Which scheduler calls `POST /api/cron/run`, how often, and what happens when a tick is missed |

  The last two are connected to the scheduling items above: a transactional
  backend is what unblocks atomic run-and-advance, so the database decision
  arrives before that work, not after.

- `削除用/dev.db.bak` — the database from before the tenant identity fix, kept
  until Closed Beta starts
