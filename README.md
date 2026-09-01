# Koqentra

A modern AI workflow automation platform.

**Using Koqentra rather than working on it?** Start here:

- **[User Guide](./docs/USER_GUIDE.md)** — what Koqentra does, what it cannot do,
  and how to run a Worker.
- **[Use Cases](./docs/USE_CASES.md)** — Worker setups with copy-paste prompts.
- **[Troubleshooting](./docs/TROUBLESHOOTING.md)** — symptoms and causes, plus a
  section for whoever operates the Closed Beta deployment.

The rest of this file is for developers.

## Vision

Build your AI workforce. Define a **worker** once — a name, a prompt, a cadence
— and let it run on schedule or on demand.

The goal is to eliminate repetitive AI work: the prompt you retype every morning
should be a worker instead.

## Architecture

Koqentra is a **multi-tenant** application. Every signed-in Google account is a
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
  │                          Dispatcher ── claims each slot, then hands off
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
| `lib/schedule.ts` | Computing *when* the next slot falls | Decide what is due, or run anything |
| `lib/dispatcher.ts` | Claiming each due slot, then the hand-off | Decide what is due, interpret a schedule, or retry a failure |
| `lib/queue.ts` | Being the boundary a run crosses | Anything else — it runs inline for now |
| `lib/prompt.ts` | Substituting `{{variables}}` | Know where the prompt came from |
| `lib/ai/*` | Talking to a model | Know about workers, users or schedules |
| `lib/runs.ts` | Recording what happened | Decide when to run |

**Templates** (`lib/worker-templates.ts`) sit outside this pipeline entirely.
They are starting values for the create form — a kind, a name, a prompt, a
frequency — and nothing reads them after a worker exists. Their words live in
the dictionary rather than in the module, so an example is offered in the
language of whoever is reading it; the address a website example needs is the
one thing they do not carry, because only the person choosing can know it.

The queue exists as a seam rather than an implementation. Swapping the inline
call for a real backend should not require changes above or below it.

**Running inline is a decision, not a placeholder.** Moving execution off the
HTTP request — a resident worker process, with or without a queue library —
was evaluated in Sprint 37 and deliberately deferred. The problem it solves has
not happened yet; the problem it introduces starts on the day it ships. The
conditions that would reopen it are in the [Backlog](#backlog), and how close
production currently is to them is in [Cron API](#cron-api).

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

**A delete has three answers, and two of them mean the worker is still there:**

| | Reports | Revalidates |
| --- | --- | --- |
| The row was deleted | `Worker deleted.` | The dashboard |
| Nothing matched | `Worker not found.` | **No** |
| The database refused the write | `Could not delete the worker.` | **No** |

Nothing matched covers a worker that does not exist *and* one belonging to
somebody else — the query asks for the id and the owner together, so the two
cannot be told apart from the answer.

**A refused write is not a worker that was not there.** Both leave the worker in
place, but only one of them means something is wrong, and the reason for it is
written to the server log rather than handed to whoever pressed the button. The
exception does not escape: it used to, onto a page the browser had already left,
because this was the one action that wrote without catching. Toasts live in the
root layout, so the message still finds the person who asked for it.

**Where the navigation happens did not change**, and the table above is what
makes that safe: a failed delete leaves the worker in the list, which is exactly
what the database now holds.

Changing the **frequency** resets the pending slot, because the old one no
longer describes the new cadence: switching to `manual` clears `nextRunAt` so
the worker stops being due, and switching away from it schedules the first slot.
Leaving the frequency alone keeps the existing slot, so editing a name or prompt
never shifts the schedule.

Changing the **status** to `paused` or `draft` takes the worker out of scheduled
execution without discarding its schedule.

**A save that matched no row is not a save.** The edit action reads the worker,
then writes it, and a worker deleted between the two leaves the write matching
nothing — it reports `Worker not found.` rather than success, and revalidates
nothing. Saying otherwise would be worse than either outcome: the form would
clear and the toast would say the change landed. **That is not optimistic
locking** and does not stand in for it: two saves that both find the row still
last-write-wins, which is [Backlog](#backlog).

### Cadence and time of day

A worker's schedule is a combination of four columns and the account's zone:

```
frequency  +  runAtMinutes  +  runAtWeekday  +  runAtDay  +  User.timezone
   ↓              ↓                ↓              ↓              ↓
how often     what time      which weekday    which date    whose clock
```

| Frequency | Uses | Reads as |
| --- | --- | --- |
| `manual` | — | Manual execution |
| `daily` | `runAtMinutes` | Every day at 09:00 |
| `weekly` | `runAtMinutes`, `runAtWeekday` | Every Wednesday at 09:00 |
| `monthly` | `runAtMinutes`, `runAtDay` | On the 15th at 09:00 |

**Each part is optional and each is ignored where it means nothing.** A worker
without a chosen time keeps whatever time its slot already had; one without a
weekday keeps the weekday it falls on. A `manual` worker has no slot to place
any of it in, and a `daily` one runs on every day there is, so a weekday given
to either is discarded rather than stored.

Times are read in the **owner's timezone**, so 09:00 means 09:00 wherever the
account is set to (see [Settings](#settings)). What is stored in `nextRunAt` is
the UTC instant that lands on.

**That applies to a time nobody chose, too.** "Whatever time its slot already
had" is the time on the owner's clock, read back off the slot rather than kept
as a UTC instant, so a worker with no `runAtMinutes` follows the same calendar
arithmetic as one with it — including across a daylight-saving change, where
holding the instant still is exactly what moves the hour.

The label — "Every Wednesday at 09:00" — is generated by
`lib/schedule-label.ts` from those values rather than stored. There used to be
a free-text `schedule` column beside them, typed by the user and reconciled
with nothing: a worker running daily could describe itself as weekly and the
app would show the lie on the card. It was dropped once the fields carrying a
real schedule arrived to replace it.

The detail page shows **Frequency** and no Schedule row: restating the same
value in other words is what caused the problem in the first place. The card
carries the phrased version, being the only view without a Frequency row.

#### Intervals are counted in calendar days

Adding 24 hours would hold the stored instant still while the wall clock moved,
and "every day at 09:00" would quietly become 10:00 for half the year in any
zone observing daylight saving. Stepping the local date and converting back to
UTC keeps the hour the user chose.

**Every frequency takes that route, whether or not a time was chosen.** There
was a second one until Sprint 35: a worker with no `runAtMinutes` had the
interval added to its stored instant instead. That copy carried its own month
arithmetic and never received the clamping described below, so a monthly worker
due on the 31st of January rolled through February to the 3rd of March — and
the 3rd then became the basis for the next step, leaving it on the 3rd for good.
It also never read `runAtDay`, so choosing a day of the month did nothing unless
a time was chosen alongside it. A schedule cannot be described in one place and
computed in two.

**Workers that already drifted do not repair themselves.** Recalculating them
cannot help: without a `runAtDay` the day they were meant to run was never
stored, and the clamped date is the only one left to read. Setting a day of the
month on the worker, or editing its schedule, is what puts it back.

Two moments have no clean answer, both at a daylight-saving change, and both
resolved by what `Intl` reports rather than by rules of ours:

- a time that **does not exist** — 02:30 on a spring-forward day lands just
  before the jump, at 01:30;
- a time that **happens twice** — the first occurrence is used, so the worker
  runs once rather than twice.

#### The next slot is never today

Every branch moves at least one interval forward. Asking for Monday on a Monday
gives the Monday after, not the one that just ran — the day a calculation is
made for has already been dispatched, and returning it would schedule a second
run on it.

That is a decision rather than an edge case: the day a calculation is made for
has already been dispatched. It is not what happens after an outage, though — a
backlog of missed slots is dropped rather than worked through one tick at a
time, which the [Scheduling Engine](#scheduling-engine) covers.

#### A month is shorter than 31 days

`runAtDay` accepts 1 to 31, and a day past the end of a month runs on that
month's **last day** instead:

```
runAtDay = 31
  January 31  →  February 28  →  March 31  →  April 30  →  May 31
                 ↑ clamped        ↑ back      ↑ clamped    ↑ back
```

**The clamping is not remembered.** `runAtDay` stays the intent and the landed
date is only a consequence of it, so February borrowing the 28th does not make
March inherit it. Leap years follow from the same arithmetic: February 2028
gives the 29th.

This is also why `Date#setUTCMonth` is not used to step a month. It rolls a day
past the end of the target month into the one after — the 31st of January
becomes the 3rd of March — and the rolled value then becomes the basis for the
next step, so a worker set for month-end silently turns into one that runs on
the 3rd and never returns. Setting year, month and day together avoids the roll,
because the day is already known to fit.

Skipping the month was the alternative and was rejected: it would leave the
schedule needing to know which months a worker was *supposed* to run in, rather
than treating every gap as a gap.

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

When that soonest slot has already passed, the card adds "Scheduled run is
overdue". This is a **derived UI state, not a stored one and not a diagnosis**:
`nextRunAt` only advances when the dispatcher claims it, so a slot still in the
past says the claim has not happened since then — nothing more. It does not
distinguish a quiet cron service from a claim that keeps failing from one that
succeeded a moment ago, so the wording never names a cause. The same check runs
per worker on its detail page, against that worker's own `nextRunAt`.

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

### Email Notifications

**A toast reaches somebody who is looking at Koqentra. This is for the runs
nobody is looking at.** A worker can be set to email its owner when one of its
runs finishes, which is the only thing Koqentra sends anywhere.

**It is off unless somebody turned it on, per worker.** The switch is one
column, `Routine.emailNotificationsEnabled`, and a checkbox on the hire and edit
forms. Every worker that existed before it did keeps behaving exactly as it did.

**Not every finished run is worth a message:**

| | Website worker | Prompt worker |
| --- | --- | --- |
| First check, which establishes a baseline | **No** | — |
| The page had not changed | **No** | — |
| The page changed and was summarised | **Yes** | — |
| The run completed | — | **Yes**, even with an empty answer |
| The run failed | **Yes** | **Yes** |
| Koqentra declined to fetch the page | **No** | — |

The two quiet website outcomes are successful runs with nothing to report; an
email about either would arrive every cadence for as long as the page sat
still. The last row is the one exception on the failure side, and it is ours
rather than the site's: a fetch refused because Koqentra asked that host a
moment ago is [politeness](#how-often-one-website-is-asked), not something the
owner can act on. **Only the notification is excluded** — the run is still
`failed`, still carries its reason, and is still what the tick's
`last_failed_at` reads.

**What decides it is never the stored text.** A website run's answer comes from
the comparison's own state and the run's status, and a throttled fetch from the
`WatcherErrorKind` that stopped it. Two of the sentences `RunHistory.output` can
hold are Koqentra' own, and a model could write either of them.

**The recipient is the owner and cannot be anything else.** There is no address
on a worker, none in the form, and none in the submission: when a run finishes,
the owner's `User` row is read through the routine and the message goes to
`User.email`, in that account's language and its timezone. A hand-started run
and a scheduled one therefore reach the same inbox, which is the only answer
that stays true when nobody is signed in.

**The order is execution, then the outcome in the database, then the email.** A
run whose outcome could not be written leaves as a `RunPersistenceError` and
sends nothing — a message arriving for a run with no page to link to would be
telling somebody something false about their own account.

**A send that fails changes nothing.** Not the run's status, not the reason a
failed run recorded, not the snapshot, not `nextRunAt`, and not the execution
lease — which is already released by the time anything is sent. Every failure
ends as one log line naming the run, the worker and a reason from a closed set:

```
[notify] could not send run=<id> worker=<id> reason=<not-configured|timeout|network|rejected|unreadable|recipient-unknown|link-unavailable|unknown>
```

**Nothing else is logged**, and nothing else may be: not the address, not the
key, not the provider's answer, not the output, and not a line of the watched
page.

**One run, at most one attempt.** There is no retry, no queue, no delivery
table, and no `notificationSentAt` — the guard against a message arriving twice
is that only one is ever tried, which the existing claim, lease and slot make
enough. Nothing bounds email separately either: what bounds it is what bounds
runs, since a message is only ever sent because a run finished.

**Plain text, through Resend's HTTP API, with no SDK.** The provider boundary
is `lib/notify/email.ts` and it is the only thing that knows which provider
this is; what leaves it is a delivery or an `EmailDeliveryError` naming one of
five reasons. The subject may carry the worker's name and is stripped of
control characters first — not as a defence, since a JSON body has no header to
inject into, but because a subject line with a newline in it reads as broken.
The body carries at most two thousand characters of what the run produced and
says where the rest is; a failure's body says only that the run failed and
links to the page, because the stored reason is a diagnostic in whatever
wording it arrived with.

Sending needs `RESEND_API_KEY` and `EMAIL_FROM`, and the link needs `AUTH_URL`
— see [Setup](#setup). **A deployment missing any of them still runs workers
normally**; it logs `not-configured` or `link-unavailable` and sends nothing.

**All three website outcomes have been through this in production**, over
2026-09-01 to 2026-09-02: a first check established a baseline and sent nothing,
a changed page was summarised by the model and arrived as an email in the
owner's inbox, and a re-run against the unchanged page sent nothing. What that
does not establish is how a send behaves when it goes wrong — no delivery has
failed in production, so `rejected`, `unreadable` and `timeout` are still
covered by tests alone. A prompt worker's completion email has not been sent in
production either; it takes the same decision and the same code, which is not
the same as having been observed.

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

**Those fallbacks are worked out before validation runs, and handed to it.**
One rule depends on what the worker will be *saved* as rather than on what the
form sent, and asking about the submitted value would let a submission that
simply omits the field through — landing on an existing `active` worker and
leaving it active. Both are pure, so nothing is read or written to decide them.

#### A worker Koqentra runs on its own has to have something to run

Only the name is always required. Description may be blank, and so may Prompt —
except on the one combination that Koqentra dispatches without anyone present:

| Status | Frequency | Blank prompt |
| --- | --- | --- |
| `draft` | any | Allowed |
| `paused` | any | Allowed |
| `active` | `manual` | Allowed |
| `active` | `daily` / `weekly` / `monthly` | **Rejected** |

```
Prompt is required for scheduled active workers.
```

**The rule is about unattended repetition, not about being runnable.** Every
worker is runnable by hand whatever its status — `paused` says so on the form
itself — so requiring a prompt of anything runnable would require one of
everything, and naming a worker before writing it is what `draft` is for. What
the three allowed rows have in common is that nothing dispatches them: `draft`
and `paused` are not selected by the [scheduler](#scheduling-engine), and an
`active` worker on `manual` has a null `nextRunAt` and so is never due.

The rejected row is the one that repeats. A blank prompt there is not a field
waiting to be filled in, it is a run that fails every slot for as long as the
worker exists — the schedule advances whether a run worked or not, and a tick
whose workers all failed still answers `200`.

**Blank means blank after trimming**, the same thing that makes a
whitespace-only name count as missing. And a hand-started run of an allowed
combination can still meet an empty prompt and fail: that is one failure, in
front of the person who asked for it, which is a different event from the same
failure repeating on a schedule with nobody watching.

**This is checked when a worker is written, not when one runs.** A worker
already stored in that state would not be repaired by it — nothing rewrites
existing rows, and nothing stops the scheduler from picking one up.

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

**A run can still be left at `running` for good** — see
[Backlog](#backlog) — and nothing rewrites its status when that happens. The
Health section adds one more line rather than a new status: a worker whose
latest run is `running` and started more than fifteen minutes ago — comfortably
past the three minutes a prompt worker's request is allowed — reads "Running for
longer than expected". This is computed at read time from `status` and
`startedAt`, not stored, and it is deliberately not called "stuck" or "failed":
the row looks identical to one that is genuinely still in progress, and only
time distinguishes them.

The dashboard derives health for every worker from the run history it already
loaded, in a single pass. The number of cards never drives the number of
queries.

### Scheduling Engine

Scheduled execution is split across three modules, each with one job:

```
Worker settings              Scheduler  ──►  Dispatcher  ──►  Queue
 frequency                    what is due     hand-off &
 runAtMinutes                      ▲          advance
 runAtWeekday                      │
 runAtDay              ┌───────────┘
 User.timezone         │
       │           nextRunAt
       └──►  lib/schedule.ts  ──►  the pending slot, in UTC
```

| Module | Responsibility |
| --- | --- |
| **Schedule** (`lib/schedule.ts`) | Turns a worker's settings into an instant. Frequency, time of day, weekday, day of month, timezone and what to do about missed slots all live here — it is the single source of truth for scheduling arithmetic, and it touches no database. |
| **Scheduler** (`lib/scheduler.ts`) | Decides *what* is due. Read-only — it never writes. |
| **Dispatcher** (`lib/dispatcher.ts`) | Owns the hand-off: claims each due slot, then enqueues the workers it won. |

**The scheduler's selection has never changed**, through every addition to how
schedules are described:

```ts
where: { status: "active", nextRunAt: { lte: now } }
```

It reads no `frequency`, no time of day, no weekday, no day of month and no
timezone. **A schedule means nothing to it** — all of that is resolved into
`nextRunAt` before it gets there, which is why four sprints of scheduling work
left this file untouched.

`Routine` carries an index on `(status, nextRunAt)` for exactly this query.
The column order is the query's shape: the equality first so it narrows, the
range second so the same index also satisfies `ORDER BY nextRunAt`. Reversed,
the range column would end the usable part of the scan and `status` would
filter nothing.

**It is indexed because the query is system-wide.** Every other read in
Koqentra is scoped to one account, so it touches one tenant's rows; this one
runs across all of them on every tick. Without the index its cost grows with
the number of workers on the platform rather than with the number that are
actually due.

Keep it that way. A condition added here is a decision moved out of the module
that owns it, and the next kind of schedule would then need changing in two
places instead of one.

The dispatcher hands the **whole worker** to the schedule module rather than
picking fields out of it. Choosing which parts of a schedule matter would be
the dispatcher deciding something, and it decides nothing.

**`nextRunAt` advances from the stored slot, never from the clock.** A worker
due at 09:00 that a cron tick picks up at 09:05 is next due at 09:00 the
following day. Late ticks cannot drag the schedule forward.

**A failed run advances the schedule too.** Execution reports its outcome by
recording it — `runRoutine` catches what a provider throws and stores the run
as `failed` — so nothing propagates back to the dispatcher, and the next slot
is set either way. The failure is not lost: it is in the run history and in the
[health summary](#worker-health), and the worker can be run again by hand.

That is a decision, not an oversight. **Koqentra executes work based on the
current execution time.** Replaying a missed slot later would not reproduce the
original context: a prompt's `{{today}}` resolves when the run happens, so
retrying yesterday's slot today produces today's work with yesterday's name on
it. Holding a slot open until it succeeds is a retry system — a different
feature, with its own questions about attempt counts and backoff, and one that
a permanently failing worker would otherwise re-run on every tick forever.

Workers with `manual` frequency keep `nextRunAt` as `null` and are never due.
So are `paused` and `draft` ones, which keep their slot but are not selected.

#### The slot is claimed before the worker runs

Advancing `nextRunAt` is not something the dispatcher does afterwards — it is
how it takes the work in the first place. `claimRoutineSlot` writes only while
the column still holds the value that was read:

```ts
where: { id, nextRunAt: expected }
```

A single `UPDATE` is atomic, so two cron ticks arriving together produce one
winner and one `false`, and the loser skips that worker rather than running it
a second time. **No transaction is involved, deliberately.** Wrapping the run
instead would mean holding one open across a call to the AI provider, which is
the case every guide on transactions tells you to avoid.

It works because the next slot is always later than the current one. A
frequency that could land on the same instant would defeat the check silently —
which is the other reason [the next slot is never today](#the-next-slot-is-never-today).

**A claimed slot stays claimed, even when the run never happens.** A process
that dies between the claim and the hand-off spends that slot, and the worker
waits for its next one. Claiming afterwards would turn the same crash into a
duplicate run instead — and a duplicate bills an API and produces real output
twice, so losing a slot is the safer direction.

**What is claimed is the slot, not the worker.** The condition is on
`nextRunAt`, so what a dispatcher wins is the right to spend one scheduled
slot — and a run with no slot in play never meets the check at all. A manual
run is exactly that: it goes straight to the queue without reading or writing
`nextRunAt`, so it neither takes a slot nor notices one being taken. A
scheduled run and a hand-started one can therefore overlap. Two hand-started
ones cannot, but nothing in this mechanism is what stops them — see [One manual
run per account](#one-manual-run-per-account).

That is the boundary of what this mechanism covers, stated because the two are
easy to read as one: it makes a scheduled slot dispatch once, and it is not a
lock on executing a worker. Preventing two runs of the same worker at once is
a separate mechanism, held per worker rather than per slot — see [One run at a
time](#one-run-at-a-time).

#### One run at a time

A slot is claimed per schedule; the right to *execute* is held per worker, and
the two are not the same thing. A hand-started run takes no slot, so nothing in
the claim above notices it — which is exactly the case where the same worker
could otherwise be running twice.

**Execution holds a lease on the worker itself.** `runRoutine` takes it before
it records anything and gives it back in the cleanup, and both paths into
execution go through there, so a scheduled run and a hand-started one compete
for the same thing:

```
scheduled   claim slot ──► hand off ──► take lease ──► run ──► release
manual                     hand off ──► take lease ──► run ──► release
```

A second arrival finds the lease held and stops **before anything exists to
describe it** — no run is recorded, no model is called, and nothing is retried.
For a cron tick that is neither a hand-off nor a failure, so the tick counts it
as neither; for someone pressing the button it reads as *already running*
rather than as a failure. **The slot a scheduled run claimed is spent either
way** — it was taken before the lease was asked for.

#### One manual run per account

The lease above is held per worker, so it says nothing about an account running
*different* workers at once. Pressing Run on four workers starts four runs, each
one legitimate on its own and each one a call to a provider or a fetch of
somebody else's website. **What bounds that is a slot held per account**, taken
in the run action after ownership has been established and given back in its
cleanup:

```
manual   own the worker ──► take account slot ──► hand off ──► take lease ──► run ──► release both
```

**Hand-started runs only.** A scheduled run never asks for one: a tick already
takes at most `MAX_DISPATCHES_PER_TICK` workers and works through them one at a
time, and refusing one because its owner was running something by hand would
make the schedule depend on what somebody happened to be doing. The bound an
account is under is therefore its manual runs, alongside whatever the tick is
doing.

**Prompt and website workers share the slot.** What is being bounded is the work
an account can ask for at once, and both kinds spend somebody else's resources —
a model's, or a website's.

**A refusal is not a failure**: nothing is recorded, no run row exists, and the
answer says another run of theirs is still going rather than that this one went
wrong. It is deliberately a different sentence from *already running*, which is
about the worker on the button rather than about the account.

**A slot lapses on its own after fifteen minutes.** A process that dies mid-run
never reaches its cleanup, and nothing sweeps the row — expiry is the whole of
the recovery, exactly as it is for the lease. The number is a product decision
about how long somebody should wait after a crash, and is deliberately neither
derived from nor shared with `EXECUTION_LEASE_MS`, which happens to be the same
fifteen minutes and answers a different question.

**It is a concurrency guard and not a rate limit**, and the two sit side by
side rather than in one mechanism — see [Twenty manual runs an
hour](#twenty-manual-runs-an-hour).

#### Twenty manual runs an hour

One run at a time is not a bound on how much work an account can ask for: a run
that finishes can be followed immediately by the next. **So a second guard
counts them** — twenty hand-started runs per account, in a fixed hour measured
from the run that opened it, exactly as AI drafting is counted and in the same
table.

**It is the same `RateLimitBucket`, under a different scope.** The row is keyed
by account *and* scope, so `manual-run` and `worker-draft` are separate rows with
separate windows: spending one cannot move the other, and neither knows the
other exists. That is what the table was for — a scope is a constant here rather
than a migration.

**Counted when a run is started, not when a model is called.** A website worker
that finds nothing changed asks no model and still spends one, because it still
fetched somebody else's page. What is bounded is the operation the account asked
for.

**Asked for after the slot and before execution**, which is what makes a second
press while a run is going free: that one is refused by the slot, having cost
nothing. The allowance is checked inside the same `try` whose cleanup gives the
slot back, so a refusal — or a database that will not answer — releases the slot
rather than leaving it held for fifteen minutes.

**Spent on the way in, and never given back.** A run that fails, a page that
could not be fetched, an outcome that could not be written down: all of them
still cost one. There is no refund and deliberately no function that could
perform one.

**Scheduled runs are not counted.** A tick takes five workers at most and works
through them one at a time; refusing one because its owner had been pressing Run
would make the schedule depend on what somebody happened to be doing.

**The lease lasts fifteen minutes and nothing renews it.** That is comfortably
longer than the ten a single request is allowed, with the rest covering what
happens around it. It is an allowance rather than a bound, and the difference
matters:

> **This is not an unconditional guarantee of one run at a time.** A run that
> outlives its own lease no longer holds it, and the next attempt may take over
> while the first is still going.

What holds regardless is that the older run cannot undo the newer one. A lease
is released only while the token that took it still matches, so a run tidying
up after it has already lost its lease writes nothing, and the run that took
over keeps its claim. That is also what makes a lost process recoverable: a
lease left behind by a process that died lapses on its own, and nothing has to
sweep it up.

#### When the outcome cannot be written

Recording what a run did is a second write, and it can fail on its own. **That
is not the run failing**, and it is not stored as one.

The execution and the writing of its result sit in different places now. What
can go wrong inside the run — a prompt, a model — becomes a `failed` row with
the reason in `errorMessage`, exactly as before. What can go wrong afterwards
leaves as a `RunPersistenceError`:

```
create the row      failure → the run never started; the tick counts it as failed
  │
run it              failure → a `failed` row, with the reason
  │
write the outcome   failure → nothing further is written; the error is raised
```

**Nothing writes a `failed` row after a run has succeeded.** It used to: the
write that stores a success shared a `try` with the execution, so a database
that refused it sent a working run down the failure path and stored the
database's complaint where the model's answer belonged. The answer was gone
and the two causes were indistinguishable afterwards.

What is left instead is the row as it last stood — the `running` it was created
with. A row sitting there long enough is what [Worker Health](#worker-health)
already reads as running longer than expected, so this surfaces without a
status of its own. **It is one of the ways that can happen, not the only one**,
and the two are not distinguishable from the row.

**Whether anything was written is genuinely unknown.** A driver that throws
after reaching the server may be reporting a lost response rather than a
rejected statement, so the row may be `running` or may be exactly what the
write intended. Nothing reads it back to find out, and nothing tries the write
again — **there is no retry**, and see the [Backlog](#backlog) for why one is
not obviously right.

A tick counts such a worker as **dispatched**: it was started, which is what
that number means. The event is in the server log, with the worker's id.

#### Missed slots are dropped, not replayed

A week of downtime leaves a daily worker seven slots behind. Advancing one
interval per tick would work through them one at a time and run the worker
eight times on the way back.

**Those eight runs would not be the eight that were missed.** A prompt's
`{{today}}` resolves when the run happens, so each of them produces *today's*
work: eight identical results, eight times the cost, and an activity feed made
of them. `advanceSchedule` resumes from the current time instead — one run to
get current, then the ordinary cadence.

```
advanceSchedule(schedule, slot, now)
  one step from `slot` reaches the future  →  take it
  it does not                              →  start again from `now`
```

**The threshold is what keeps this from touching ordinary lateness.** A tick
five seconds late is not an outage, and treating it as one would move a 09:00
worker to 09:00:05 and keep sliding. Only a slot whose *successor* is also in
the past counts as missed, so a late tick leaves the chosen time exactly where
it was.

Dropping the backlog is safe because the destination is identical either way: a
worker seven days behind lands on the same instant as one that never missed a
run. What is lost is the count — **nothing records how many slots were
skipped**, which is the known cost of the choice.

The decision lives in `lib/schedule.ts` rather than in the dispatcher. What to
do about a missed slot is a scheduling policy, and the dispatcher holds none.

#### One worker failing is one worker failing

The dispatcher catches per worker. Anything thrown while claiming or handing
off used to escape the loop and end the tick — and due workers are ordered by
`nextRunAt`, so one broken worker took every worker behind it, and the same
ones lost every time.

The failure is logged with the worker's id and the loop carries on. **That is
not a retry.** The claimed slot is still spent and the worker still waits for
its next one, exactly as it would have; the only decision is to continue with
the rest of the list.

How many failed comes back with the result, and the [Cron API](#cron-api)
passes it on. Without it a tick where nothing could be handed off would be
indistinguishable from a quiet one — both report zero dispatched and both
return `200`.

**It counts hand-offs, not runs.** What is caught here is a worker that could
not be *started*: a claim that threw, a worker deleted out from under the tick,
a row that could not be written. A worker whose run then fails is not caught
here at all — execution reports its outcome by recording it rather than by
throwing, so the hand-off succeeded and the worker is counted as dispatched.
The two failures are different events, and only one of them reaches this
number:

| Failure | Counted as | Where it shows |
| --- | --- | --- |
| Could not hand the worker off | `failed` | The tick's result, and a log line with the worker's id |
| The run itself failed | `dispatched` | A `failed` row in the run history, and the [health summary](#worker-health) |
| The worker was already running | **neither** | A log line with the worker's id, and nothing else — see [One run at a time](#one-run-at-a-time) |
| Its outcome could not be written down | `dispatched` | A log line with the worker's id — see [When the outcome cannot be written](#when-the-outcome-cannot-be-written) |

**The third row is the one that leaves no trace in the numbers.** A worker
already running was not handed off and did not go wrong, so counting it as
either would say something untrue. Its slot is spent all the same: the claim
happened before the hand-off, and nothing gives it back.

#### `lib/schedule.ts` computes and nothing else

Every function in it is pure. The module reads no rows and imports no database
code, so what comes back depends only on what was handed in. That is what makes
it the single place scheduling arithmetic lives, and the only part of the
pipeline with unit tests.

| Entry point | Answers |
| --- | --- |
| `calculateNextRunAt(schedule, from)` | Where the slot after `from` falls |
| `advanceSchedule(schedule, slot, now)` | Where a worker goes once `slot` is taken, catching up at most once |

`from` and `slot` are slots, never the clock. `advanceSchedule` is the only one
told what time it is, and it is *told* rather than allowed to look — which is
what keeps its answer reproducible.

| Caller | Uses | Where the timezone comes from |
| --- | --- | --- |
| The hire and edit actions | `calculateNextRunAt` | The signed-in user, read once per submission |
| The dispatcher | `advanceSchedule` | The owner of the worker being claimed |

**Resolving the timezone belongs to the caller, not to the module.** For the
dispatcher that is no extra responsibility: it already loads the due workers
and writes the new slot back, so reading one more column changes nothing about
what it decides. Keeping the lookup out of `lib/schedule.ts` is what leaves the
arithmetic testable on its own.

### Settings

`/dashboard/settings` holds what applies to the account rather than to one
worker. Today that is the **timezone**, which decides both how timestamps read
and what a worker's chosen time of day means.

The zone comes from a fixed list (`lib/timezones.ts`) rather than free text, and
the action checks the submitted value against that list before writing. A form
post is not a promise: an unrecognised zone would make `Intl` throw on every
render, and it is the value scheduled execution is calculated against.

Saving revalidates the whole dashboard, since every screen renders timestamps.

The zone is read from the database on each request rather than carried in the
session. A JWT is issued at sign-in and would keep serving the old value until
the next one, so a changed setting would appear to do nothing.

## Features

### Current

**Accounts**

- Google Authentication (Auth.js v5, JWT sessions)
- Closed Beta admission — sign-in limited to an invited list of addresses
- Multi-tenancy — every row scoped to its owner, 404 on someone else's
- Settings — a timezone for the account, applied to every timestamp and to
  scheduled execution
- Privacy notice at `/privacy`, describing what is stored and what is not

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
- Scheduled Run — `daily`, `weekly` or `monthly`, at a chosen time of day, on a
  chosen weekday or day of the month
- Scheduler — decides what is due
- Dispatcher — claims each due slot, then hands it off. One worker failing does
  not stop the rest of the tick
- Catch-up — an outage costs one run to get current, not one per missed slot
- Queue — the hand-off boundary, inline for now
- Cron API — `POST /api/cron/run`
- Claude Provider — real AI execution when `ANTHROPIC_API_KEY` is set
- Run History — every execution, with status and output

**Storage**

- PostgreSQL + Prisma

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
| Database | **PostgreSQL** + **Prisma 7** | Prisma 7 requires a driver adapter (`@prisma/adapter-pg`). Locally, PostgreSQL comes from `compose.yaml` |
| Styling | **Tailwind CSS v4** | Theme tokens in `app/globals.css` |
| Components | **shadcn/ui** (Base UI) | Note: Base UI, not Radix — buttons take `render`, not `asChild` |
| Icons | **lucide-react** | |
| AI | **Anthropic SDK** | Behind a provider interface; falls back to a stand-in without an API key. Timeout and retries are set explicitly — see [Setup](#setup) |
| Testing | **Vitest** | 16 files, 307 tests. Schedule arithmetic, the scheduler's query, the dispatcher, execution and its lease, health and overview, the provider boundary, the cron API, the session boundary, form validation, prompt rendering, and all five server actions. **Not the database's own guarantees, and no component** — see [Backlog](#backlog) |
| CI | **GitHub Actions** | `.github/workflows/ci.yml` runs lint, types, tests and build. No secrets, no database |

Two details bite anyone who assumes the usual defaults:

- **shadcn/ui here is built on Base UI.** A `<Button>` rendered as a link needs
  `render={<Link/>}` *and* `nativeButton={false}`; `asChild` does not exist.
- **Prisma 7 needs a driver adapter.** `lib/prisma.ts` constructs one; a plain
  `new PrismaClient()` will not connect.

### How Prisma connects

Prisma 7 splits the connection across three files, and the connection URL is
**not** one of them — `schema.prisma` has no `datasource url`, because Prisma 7
rejects the schema outright if it finds one (`P1012`).

| File | Holds | Used by |
| --- | --- | --- |
| `prisma/schema.prisma` | `provider = "postgresql"` and the models — no URL | Both, for the shape of the data |
| `prisma.config.ts` | `datasource.url` | The Prisma CLI (`migrate`, `studio`) |
| `lib/prisma.ts` | `new PrismaPg({ connectionString })` | The application at runtime |

Both read the same value from `lib/db-url.ts`, which prefers `DATABASE_URL` and
falls back to the `compose.yaml` container, so a fresh checkout can migrate
without setting anything. **That fallback protects the CLI only** — see
[Local Development](#local-development) for why the running app is different.

## Data Model

Every owned row carries `userId` so a query can be scoped without a join, and
every relation cascades on delete.

```
User ──┬── Routine ──── RunHistory
       └── RunHistory
```

| Model | Purpose | Key points |
| --- | --- | --- |
| **User** | What Koqentra keeps for an account, not the account itself | `id` is the provider account id, not a generated key. Written lazily — see [Account Provisioning](#account-provisioning) |
| **Routine** | A worker | Four columns define the schedule; `nextRunAt` is what it resolves to |
| **RunHistory** | One execution | `userId` denormalised from the routine |
| **RateLimitBucket** | How much of a rate-limited action an account has used | One row per account and scope, rewritten in place — see [AI drafting is bounded](#ai-drafting-is-bounded) |

`Routine.emailNotificationsEnabled` is a `Boolean` defaulting to `false`, and it
is the whole of what notifications added to the schema: **there is no delivery
table, no sent-at column, and no address anywhere**. Who a message goes to is
the owner of the routine, read from `User.email` when a run finishes — see
[Email Notifications](#email-notifications).

The columns that carry a schedule:

| Column | Type | Meaning |
| --- | --- | --- |
| `User.timezone` | `String` (default `"UTC"`) | IANA zone. Decides how timestamps read *and* what a chosen time or day means |
| `Routine.frequency` | `String` (default `"manual"`) | How often: `manual`, `daily`, `weekly`, `monthly` |
| `Routine.runAtMinutes` | `Int?` | Minutes into the day in the owner's zone: `0` is midnight, `540` is 09:00. Null keeps the slot's existing time |
| `Routine.runAtWeekday` | `Int?` | `weekly` only. 0 (Sunday) to 6 (Saturday), matching `Date#getUTCDay` so no conversion sits between the column and the arithmetic. Null keeps the slot's existing weekday |
| `Routine.runAtDay` | `Int?` | `monthly` only. 1 to 31; a day past a month's end runs on its last day. Null keeps the slot's existing date |
| `Routine.nextRunAt` | `DateTime?` | What all of the above resolves to, in UTC. Null means never due |

**The first five are intent; the last is a consequence.** Only `nextRunAt` is
read when deciding what to run, and it is recalculated whenever any of the
others changes — editing a name or a prompt never shifts a schedule.

**Deleting a User removes its routines and runs. Deleting a Routine removes its
runs.** Both are `onDelete: Cascade` in the schema, which is why deleting a
worker needs no cleanup code.

`status` and `frequency` are plain string columns, so `lib/routines.ts`
narrows them at the boundary and falls back to `draft` / `manual` on anything
unrecognised. The same applies to `RunHistory.status`.

What a run records is split so that neither half has to be read through
`status` to know what it is:

| Column | Type | Holds |
| --- | --- | --- |
| `RunHistory.output` | `String` (default `""`) | What the model produced, and only that. Empty on a run that failed or is still going |
| `RunHistory.errorMessage` | `String?` | Why a run failed. Null on every run that did not |

**They used to be one column.** A failed run put its reason in `output`, so the
same field meant two things and the reader had to know which — and neither
screen that showed it checked. The reason is a diagnostic in whatever wording
the failure arrived with, so it belongs on one execution's page rather than in
a list; the activity feed shows output alone.

**Two sentences in `output` are Koqentra' own**, and they are the only ones: a
website worker's first check and one that found nothing have no model answer to
record, so the run says so for itself. They are stored in English and
**translated when shown**, which is why a run from before an account changed its
language still reads in the current one. Recognising them is exact — the worker
must be a `website` worker and the stored text must match one of the two word
for word — because everything else in that column is what a model wrote, and
that is the account's material rather than ours to reword. See
`lib/run-display.ts`.

**Every stored `DateTime` is UTC**, which is what makes them comparable and
what the scheduler relies on. A timezone changes how they are read, never what
is stored.

## Local Development

Requires **Docker Desktop** — PostgreSQL runs in a container defined by
`compose.yaml` (image `postgres:17-alpine`, published on **port 5433** so it
cannot collide with a PostgreSQL already installed on 5432).

```bash
pnpm install
docker compose up -d              # start PostgreSQL, wait for healthy
pnpm exec prisma migrate deploy   # apply migrations
pnpm exec prisma generate         # generate the client
pnpm dev                          # http://localhost:3000
```

Three things to know before the first run:

- **PostgreSQL has to be up.** Nothing that touches the database works without
  it — not the app, not `migrate`, not `studio`.
- **`.env` must point `DATABASE_URL` at PostgreSQL.** `.env.example` holds the
  value that matches `compose.yaml`.
- **A stale `DATABASE_URL` fails in only one place.** Prisma 7 does not load
  `.env`; Next.js does. So the CLI falls back to the `compose.yaml` container
  and appears to work, while the running app connects to whatever `.env` says.
  A leftover value from an earlier setup therefore produces migrations that
  succeed and pages that throw. If the CLI is happy and the app is not, check
  `DATABASE_URL` first.

Everything else:

```bash
pnpm lint
pnpm exec tsc --noEmit            # types; `pnpm build` also checks them
pnpm test                         # `pnpm test:watch` while working
pnpm build
```

These four are what CI runs on every push, and they need no database. Nothing
under test reaches one: `server-only` is aliased to the same empty module
Next.js resolves it to, and the persistence layer is stood in for. **What the
database itself guarantees is therefore covered by none of them** — that a
claim or a lease is atomic, and how catch-up behaves against real rows, are
still verified by hand against a running app.

Database:

```bash
pnpm exec prisma migrate dev      # create and apply a migration
pnpm exec prisma migrate deploy   # apply existing migrations
pnpm exec prisma migrate status   # check the database matches the migrations
pnpm exec prisma studio           # browse the data
```

`pnpm build` while `pnpm dev` is running corrupts `.next` and the app starts
serving broken chunks. Stop the dev server first; if it already happened,
`rm -rf .next` and restart.

## Setup

`.env.example` lists every variable Koqentra reads. Copy it to `.env`, then fill
in the values:

```bash
cp .env.example .env
```

| Variable | Required | What it is |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection string. The committed value matches `compose.yaml` |
| `AUTH_SECRET` | Yes | Signs the session JWT |
| `AUTH_GOOGLE_ID` | Yes | Google OAuth client id |
| `AUTH_GOOGLE_SECRET` | Yes | Google OAuth client secret |
| `CRON_SECRET` | Yes | Bearer token for `POST /api/cron/run`. Unset means every request is rejected |
| `BETA_ALLOWED_EMAILS` | Yes | Comma-separated addresses allowed to sign in. **Unset means nobody can** — see below |
| `AUTH_URL` | **In production** | The deployed origin, e.g. `https://koqentra.example.com`. Leave it unset locally — see below |
| `ANTHROPIC_API_KEY` | No | Real AI execution. Without it, a stand-in provider answers |
| `RESEND_API_KEY` | No | Sends [email notifications](#email-notifications). Without it, nothing is sent and a line is logged |
| `EMAIL_FROM` | No | The sender those are from, e.g. `Koqentra <notifications@example.com>`. Needed alongside the key; either one missing sends nothing |

`.env` is gitignored; `.env.example` is committed and holds no real values.

### `BETA_ALLOWED_EMAILS` refuses everyone until you set it

**It is not optional, and "unset" is not "unrestricted".** Koqentra is
invite-only while it is in Closed Beta, and the list is what decides who is
invited. An unset, empty, or whitespace-only value parses to an empty list, and
an empty list turns every sign-in away — **including yours, locally**. That is
the same direction `CRON_SECRET` fails in, and for the same reason: a variable
somebody forgot must not quietly reopen the door.

```bash
BETA_ALLOWED_EMAILS=you@example.com,teammate@example.com
```

Three conditions have to hold for a sign-in to go through: Google returned an
address, Google says it is verified, and that address is on the list. Both
sides are trimmed and lower-cased before they are compared, and **nothing else
is done to them** — the dots Gmail ignores and the `+tag` some providers treat
as an alias are not interpreted here, because guessing wide would admit an
address nobody wrote down. Put the address exactly as it is.

**A refused sign-in leaves nothing behind.** The check runs before a token is
issued, so there is no session and no `User` row — see
[Account Provisioning](#account-provisioning) — and the visitor comes back to
the landing page, which says only that the beta is invite-only.

**Changing the list needs a restart.** It is read once when the process starts,
as the AI provider reads its own key once. In production that means updating
the variable and then redeploying or restarting; the running process will not
notice on its own.

**Adding a deployment before the variable locks everyone out.** Set
`BETA_ALLOWED_EMAILS` first, confirm it is there, and deploy the code after.

**Removing somebody from the list does not sign them out.** Sessions are JWTs
with no server-side store, so a token already issued stays valid until it
expires. The list controls who can sign in next, not who is signed in now.

### `AUTH_URL` is only needed once you deploy

**Sign-in works locally without it and stops working in production without it**,
which is an easy thing to be caught by. Auth.js decides whether to trust the
`Host` header it is given, and with nothing configured it works the answer out:

```ts
trustHost ??= !!(AUTH_URL ?? AUTH_TRUST_HOST ?? VERCEL ?? CF_PAGES ??
                 NODE_ENV !== "production")
```

Locally `NODE_ENV` is `development`, so the last term is `true` and the host is
trusted. `next start` sets `NODE_ENV` to `production`, and on a host that is
not Vercel or Cloudflare Pages none of the earlier terms are set either — so
the host is **not** trusted and Google sign-in fails.

Setting `AUTH_URL` to the deployed origin settles it, and also tells Auth.js
the canonical URL to build OAuth callbacks from when it sits behind a proxy.
`AUTH_TRUST_HOST=true` satisfies the same check but says less.

When `ANTHROPIC_API_KEY` is set, workers run against the Claude API. Without it,
Koqentra falls back to a stand-in provider that returns a fixed response. **That
fallback exists so the app is usable without a key**: the whole pipeline —
scheduling, claiming, dispatch, run history — can be exercised locally, and
against a live model only when you want to be.

**It is also the one misconfiguration that does not announce itself.** A
missing key in production is not an error:

| | Without `ANTHROPIC_API_KEY` |
| --- | --- |
| Which provider runs | The stand-in, returning a fixed string |
| What the run history records | **`completed`** — a success, like any other |
| What the health summary shows | Green. No failures to count |
| What tells you | **Only the startup log line below** |

Nothing downstream can tell: by the time a run is written, which provider
produced it is no longer knowable.

The only signal is a line logged once per process when the fallback is chosen:

```
[ai] ANTHROPIC_API_KEY is not configured — using the stand-in provider.
```

**Check for it after deploying.** Seeing it in development is expected;
seeing it in production means every scheduled worker is producing a fixed
string.

**How long a request may take, and how often it is retried, are Koqentra'
decisions rather than the SDK's.** `lib/ai/claude-provider.ts` passes both: ten
minutes per request, and **no retries**. Neither value changes what the SDK
would have done on its own by much — it defaults to the same ten minutes for
this token count — but leaving them implicit meant the default also brought two
automatic retries with it, which nobody chose and which bills a timed-out
generation three times over.

**Those ten minutes are a fallback, and nothing in production reaches them.**
Each caller names the deadline its own work has to fit inside, and there are
three: a prompt worker gets **three minutes**, a website change **two**, and a
draft **thirty seconds**. They are deliberately different numbers — a website
change is one step of a run that has already fetched a page, a draft is
somebody waiting at a form, and a prompt worker's request is the whole of its
run. What they have in common is that each is shorter than the tick it runs
inside; the fallback was shorter than nothing. **`maxRetries: 0` is what switches the SDK's own
retrying off**, and it puts this layer where the
[dispatcher](#scheduling-engine) already stood: deciding that a failure deserves
another attempt is a policy, and nothing in the pipeline holds one. A request
that times out throws, is recorded as a `failed` run like any other failure, and
the worker comes round again at its next slot.

**The trade-off is real.** A rate limit or a passing `5xx` now fails the run
outright, where the SDK would have retried and often succeeded on the second
attempt. That is the price of the pipeline saying what it does: the failure
lands in the run history and the [health summary](#worker-health), which is
where an argument for a retry policy should come from — not from a default
nobody read.

### AI drafting is bounded

**Ten drafts an hour, per account.** Asking Koqentra to write a worker from a
sentence is the one place a signed-in person can spend model time without a
worker existing yet, and nothing else stood between a held-down button and the
bill. The limit is the account's, not the browser's: a form that has disabled
its own button is not what enforces it, and a request made straight to the
server action is counted the same way.

**A fixed hour measured from the request that opened it**, rather than a
calendar hour. The window starts when the first request arrives and ends
exactly an hour later — the same rule for every account, in every timezone, and
one that cannot be reset by signing out, waiting for a deploy, or arriving at
59 minutes past.

**It is a row in the database, and that is the point.** A counter kept in the
process would reset on every restart and would stop being one limit the moment
a second replica existed; both are ordinary here. The count is moved by the
database — the limit is a condition inside the `UPDATE` rather than a number
read back and compared — which is what makes two requests arriving together
produce one increment. It is the same shape as `claimRoutineSlot` and
`acquireExecutionLease`, and `lib/rate-limit.ts` is where it lives.

**Spent on the way in, and never given back.** The count moves immediately
before the model is asked, so a generation that fails, times out or is refused
still costs one: what is being bounded is the asking. A request the form
rejected, or one there is no AI configured to answer, is not counted at all and
does not even create the account row.

**A database that will not answer fails closed.** Not knowing how much of the
allowance is left is not the same as knowing there is some, so drafting stops
and no request is made. The driver's own complaint goes to the log and never to
the screen.

**This bounds AI drafting and nothing else.** Running a worker by hand is
bounded by nothing here or anywhere else, so a sentence saying Koqentra rate
limits its AI usage in general would be false.

### What kind of failure it was

`lib/ai/provider.ts` names the ways a provider can fail — `timeout`,
`rate-limited`, `unavailable`, `unreachable`, `unauthorized`,
`invalid-request`, `refused` — and `ClaudeProvider` sorts what the SDK throws
into them, so **the SDK's own error type never leaves `lib/ai/`**. What crosses
the boundary is a `ProviderError` carrying a kind, the provider's own message,
and the original as its `cause`.

The kinds exist because they lead somewhere different. A rate limit is the one
client error that says nothing about the request — the same call succeeds
later — while a refusal is a property of the prompt and will not. That is the
distinction a retry policy would be built on, and until now nothing recorded
it: every failure became one `failed` row carrying one string.

**The kind is still written to the server log and nowhere else.** Naming a
column for it means deciding what `failed` means, and that question is [still
open](#backlog) — and nothing has happened in production to answer it with,
since no run has ever failed there. What changed is that the evidence for
answering it would now exist.

**The message itself is stored, and it is stored on its own.** A failed run
records the failure's own wording — the same string as before, unchanged — in
`errorMessage`, while `output` stays empty. The two used to share one column,
which meant neither could be read without checking `status` first, and neither
of the two screens that read it did.

A `ProviderError` also carries `safeMessage`: the same failure said without
naming a status code, a model, or an SDK. **Nothing reads it yet**, and
separating the columns did not change that. What is stored is a diagnostic
written for whoever is debugging the provider, which is why one execution's own
page shows it and the activity list does not.

### Prompt Variables

A prompt may contain `{{name}}` placeholders, substituted at the moment of each
run:

| Variable | Becomes | Example |
| --- | --- | --- |
| `{{today}}` | The date, ISO 8601 | `2026-08-03` |
| `{{now}}` | The full timestamp, ISO 8601 | `2026-08-03T00:17:38.000Z` |

Both are UTC. **An unknown name is left in place** rather than replaced with an
empty string, so a typo shows up in the output instead of silently vanishing.

**Only those two are names.** The substitution asks whether the variables
carry a name of their own, not whether anything answers to it — `{{constructor}}`
and `{{toString}}` are as unknown as `{{yesterday}}` and are left where they
are. Asking with `in` had answered for everything a plain object inherits, so
those two were replaced with a stringified function. Nothing was exposed by it
that a prompt could not already say; it was simply the wrong answer.

### Cron API

`POST /api/cron/run` is the entry point for scheduled execution. It asks the
dispatcher to run every worker that is due and reports how many it handed off
and how many it could not.
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

Success (`200`) — `dispatched` is the number of workers handed to the queue,
`failed` the number that could not be:

```json
{ "success": true, "dispatched": 3, "failed": 0 }
```

⚠️ **`failed` does not count runs that failed.** It counts workers that never
started: a claim that threw, a worker deleted mid-tick, a row that could not be
written. A run that fails after a successful hand-off is recorded as a `failed`
run and counted here as **dispatched** — the tick did its job, the work did
not. **A tick in which every single AI call failed still answers**
`{"success": true, "dispatched": N, "failed": 0}`.

Monitor the two separately:

| Question | Where to look |
| --- | --- |
| Did the tick run at all? | HTTP status. Anything but `200` |
| Could every due worker be started? | `failed` in this response |
| Did the work succeed? | **Not here.** The run history, per worker |

Nothing due (`200`):

```json
{ "success": true, "dispatched": 0, "failed": 0 }
```

**The same two zeroes also describe a tick whose due workers were all already
running.** Neither outcome is counted, so the response cannot tell them apart —
the log can, one line per worker.

**A `200` with a non-zero `failed` is a partial success**, and the only signal
in this response that anything went wrong — the loop no longer stops at the
first failure, so the status code stays `200` even when every hand-off throws.
The causes are in the server log, one line per worker, with the id. `500` is
reserved for a tick that could not run at all.

```json
{ "success": true, "dispatched": 2, "failed": 1 }
```

Missing or wrong secret (`401`):

```json
{ "success": false, "error": "Unauthorized" }
```

Failure (`500`) — the cause is written to the server log only:

```json
{ "success": false, "error": "Internal Server Error" }
```

#### How long a tick took

Every completed tick writes one line to the server log:

```
[cron] tick finished — duration_ms=35 dispatched=0 failed=0
```

**It is not in the response**, and that is the point. What a tick reports to
its caller is the queue contract, which changes when `take`, concurrency and
the execution lock are decided — all at once, or not at all. A number that only
an operator reads belongs in the log, the same place a rejected request's
reason and the [provider failure kinds](#what-kind-of-failure-it-was) already
live.

The measurement wraps the dispatcher call inside the route. **The dispatcher is
not involved and does not know it is being timed** — it decides what a tick
does, and how long that took is not one of its decisions.

A tick over **150 seconds** is logged at `warn` instead. The threshold is half
of the five minutes Railway's edge allows a response that has sent no data, and
half rather than most of it because **a tick is a sum, not an average**: due
workers run one at a time, so a single worker taking 150 seconds is a tick that
breaches the moment a second worker is hired. Five minutes is also the cron
interval, so a severed response and a tick still running when the next one
starts arrive together rather than one warning of the other.

**Nothing acts on the threshold.** It does not stop a tick, retry it, record
it, or change what runs — it chooses `warn` over `log` and nothing else, the
same standing the fifteen minutes in [Worker Health](#worker-health) has.
Deciding what to do about a slow tick is a decision for whoever reads the line.

#### Knowing the tick happened at all

A tick that fails says so: the HTTP status carries it. **A tick that never runs
says nothing**, and nothing inside Koqentra can notice its own absence — no
request arrives, and a dashboard with nothing due looks the same either way.

That is what a **dead man's switch** covers, and it is the one piece of
monitoring that cannot live inside the deployment it watches. A check on
[Healthchecks.io](https://healthchecks.io) expects a ping every **5 minutes**
and allows a further **15** before it alerts, so silence is reported roughly
twenty minutes after the last tick that worked.

The cron service sends it, and only once Koqentra has answered:

```
A && (B || true)
```

`A` is the call to `/api/cron/run`, `B` is the ping, and two properties follow
from that shape rather than from anything being checked:

- **A tick that failed sends no heartbeat.** `--fail-with-body` turns a `4xx`
  or `5xx` into a curl failure, so `&&` stops there and the check falls silent.
  Without the flag curl exits `0` on an HTTP error and the ping would go out
  anyway, which is the failure mode this exists to avoid.
- **A heartbeat that failed is not a tick that failed.** `|| true` absorbs it,
  and the ping carries `--max-time 10` of its own so a hanging monitor cannot
  hold the container open. **Watching something must not change what it does**
  — the same rule the [duration threshold](#how-long-a-tick-took) follows.

**It watches for silence, not for failure.** A tick that hands off nothing
pings exactly like a busy one, and so does a tick whose worker then failed —
the tick did its job. Noticing a failing *execution* needs a different signal,
and there is not one; see the [Backlog](#backlog).

The ping URL is a credential — it is all anyone needs to tell the check that
everything is fine — so it lives in a Railway variable and appears in no file
here.

#### Knowing whether the runs inside it worked

The heartbeat above says the tick happened. **It says nothing about what the
tick ran**, and neither does the response: `dispatched` counts workers that
reached a provider, so a tick whose every run failed still answers `200` and
still pings. The failures land in run history, where only the account that owns
the worker can see them — nothing reads run history across tenants, so an
operator watching a Closed Beta had no way to notice.

Every tick now writes one more line:

```
[cron] execution failures — last_failed_at=none
[cron] execution failures — last_failed_at=2026-08-11T13:15:22.129Z
```

It is a read of `RunHistory` for the newest row that is `failed` and has
finished, asking for that one timestamp and nothing else — no prompt, no
output, no message, no id, nobody's email.

**It is an observation and not one of the things it resembles.** Not a
notification, not an alert, not a threshold, not a count, and not a window.
There is no automatic signal of any kind: somebody has to read the log. What
changed is that reading it now answers the question.

**There is no window, deliberately.** A window would need a length, and the
only honest source for one is the cron interval, which lives in the platform's
configuration rather than in this repository — copying it here would put the
same number in two places that nothing keeps in step. The newest failure needs
no window: it cannot miss one, and it repeats on every tick until something
newer replaces it. **The same timestamp appearing tick after tick is expected**,
and reading it as a fresh failure each time would be a misreading.

**It cannot say how many**, which is the cost of having no window. One worker
failing once and every worker failing look the same on a single line — though
not across several, since a failure that keeps happening keeps the timestamp
fresh while a one-off visibly ages.

**Manual and scheduled runs are not distinguished.** `RunHistory` records no
trigger, so a run someone started by hand is as much a candidate as one a tick
dispatched. That cuts both ways: a hand-started failure raises the line when
nothing scheduled went wrong, and a provider that has stopped working is caught
sooner because either kind of run reveals it.

**It reads run history and nothing else**, rather than whatever the dispatcher
happened to return. That keeps it clear of the queue contract — see
[Execution Pipeline](#execution-pipeline) for why that return value is not
something to build on.

**Observing cannot change what it observed.** A failure to read this is caught
where it happens: the tick still answers `200`, the heartbeat still fires, and
the reason goes to the log. Letting it fail the tick would make the monitoring
decide the outcome it was supposed to be watching.

### Authentication

The dashboard is behind Google sign-in (**Auth.js v5**, JWT sessions, **no
database adapter**). All three `AUTH_*` variables are required to sign in.

**Being able to sign in is not the same as being allowed to.** While Koqentra is
in Closed Beta, a `signIn` callback checks the address Google returned against
[`BETA_ALLOWED_EMAILS`](#beta_allowed_emails-refuses-everyone-until-you-set-it)
and refuses anyone not on it. The check is a pure function in
`lib/beta-access.ts` rather than logic inside `auth.ts`, which keeps that file
free of anything the edge cannot run — the same constraint that rules out a
database adapter — and makes the rule testable on its own. When the beta ends,
the file goes and the callback with it.

Nothing about a refusal is logged. The address that was turned away and the
list it was compared against are both things a log would then be holding, and
the person it concerns already learns the outcome from the page they land on.

Skipping the adapter is deliberate: `auth.ts` stays free of database imports, so
the middleware protecting `/dashboard/*` runs on the edge without a round trip.
The cost is that nothing writes the `User` row at sign-in — see
[Account Provisioning](#account-provisioning) for where it does get written.

That same choice is why the tenant key comes from `account.providerAccountId` —
see [Tenant Identity](#tenant-identity) before touching anything in `auth.ts`.

### How many workers an account may have

**Twenty workers, ten of them active.** Draft, paused and active all count
towards the first; both kinds do, and so does a `manual` worker that happens to
be active — the limit is about the state somebody can see and change rather than
about what the scheduler will do with it. What the scheduler actually picks up
is narrower and unchanged: `active` *and* a cadence other than `manual`.

**The worker rows are the count.** There is no counter column and no quota
table, so pausing a worker or deleting one frees capacity by itself. Nothing has
to be told, and there is no second number that can drift away from the first.

That decision is what makes the rest of it interesting, because a count is not
something a conditional `UPDATE` can be written against the way `claimRoutineSlot`
and the leases are. Counting and then writing is a check-then-act, and under
PostgreSQL's default READ COMMITTED two requests can both count nineteen and
both insert.

**So the account row is the serialization point.** Every operation that could
raise either count runs in one transaction that starts by writing the account's
own row — a self-assignment, `id` set to the value it already has — which holds
that row until the transaction commits. A second request for the same account
waits there and then counts what the first one wrote. Different accounts write
different rows and never wait on each other.

```
lock the account row  →  count the account's workers  →  write  →  commit
```

**`data: {}` would not do this**, which is why `lib/worker-quota.ts` says so at
the line rather than in a commit message: Prisma issues no `UPDATE` at all for an
empty `data` and turns the call into a `SELECT`, taking no lock. Both behaviours
were measured against local PostgreSQL rather than reasoned about. **`User`
carries no `updatedAt` and no trigger, so nothing about the account changes —
adding such a column later means re-examining this lock**, which would otherwise
start stamping an account every time one of its workers is created.

**Only the two paths that can raise a count ask.** Creating a worker asks about
both limits; an edit asks about the active one only when it is turning a worker
on — a worker that is already active is part of the count rather than an
addition to it, so editing its name is never refused. Pausing and deleting ask
nothing.

**It bounds how many, not how often.** An account may delete and recreate
workers all day; what this stops is one account occupying an unbounded share of
the platform, and — through the active limit — an unbounded number of scheduled
runs nobody has to press a button for.

### How often one website is asked

Every other guard here is an account's — drafts an hour, one run at a time,
twenty runs an hour, twenty workers. **This one is nobody's account's.** What it
protects is somebody else's website, and a site being fetched every second
cannot tell which accounts the requests came from; two people watching the same
page are, from the site's side, one visitor.

**Ten seconds between fetches of the same host, across the whole platform.** The
key is the hostname exactly as the URL parser normalised it — lowercased, and
punycoded if it was not ASCII. No scheme, no port and no path, and no attempt to
group `www.example.com` with `news.example.com`: telling which names share an
owner needs the Public Suffix List, and guessing it wrong makes unrelated sites
on a shared domain wait for each other, which is worse than counting one site
twice.

**A turn is taken by moving a time forward.** `DomainThrottle` holds one row per
host and one column that matters — when the next fetch may begin — and the write
that takes a turn is the same conditional `UPDATE` the leases use. Nothing is
held, so nothing has to be released: a process that dies mid-fetch leaves no
lock behind, and there is no TTL to choose.

**Manual and scheduled runs go through it alike, and so does every redirect
hop.** The check sits in the fetch itself, before the name is even resolved, and
a redirect arrives there as an ordinary hop — so the site at the end of a chain
is spaced out exactly as the one at the start. From the site's point of view a
request that arrived because something else pointed at it is still a request.

**Waiting happens inside the twenty-second fetch budget**, never alongside it. A
hop that finds the host busy waits as long as the throttle asked for — clamped
by what is left of the budget — and tries exactly once more. That keeps the
promise this layer makes unchanged: a fetch takes at most twenty seconds,
whatever happens, which is what a tick working through workers one at a time
relies on. **The database is never asked to wait**; `lib/website-throttle.ts`
answers whether now is a turn and how long until the next one, and
`lib/watcher/fetch.ts` decides whether waiting is worth it.

**A hop that still cannot go ahead fails as `throttled`**, and the run is
recorded the way every other failed fetch is: the row that was created when
execution started is updated to `failed`, with a fixed sentence that names no
host and no address. **The baseline is untouched** — nothing was fetched, so the
change is still there to be found next time. A manual run's quota is not given
back, for the same reason it is not given back when a page fails to load.

### Account Provisioning

**Being signed in and having a row are different things**, and Koqentra keeps
them apart. The identity comes from the token. The row is application data: it
holds the account's timezone, and it is what a worker's foreign key points at.
Nothing creates it until something needs it, and signing in is not that.

Two functions divide the question, and the split is the contract:

| | Answers | Writes |
| --- | --- | --- |
| `requireUserId()` | Who is asking | **Nothing** |
| `requireProvisionedUserId()` | Who is asking, *and* guarantees their row exists | An upsert |

**Reads use the first.** Every page renders without the row — `getUserTimezone`
falls back to UTC — so provisioning on the way in would put a write behind
every page view and buy nothing.

**Writes that need the row use the second**, and today those are creating a
worker, saving a timezone, and asking Koqentra to draft a worker — that last one
writes no worker, but it does spend an allowance whose row points at the
account. Deleting, editing or running a worker does not:
each acts on a `Routine`, whose existence already proves the row is there. That
is the rule rather than "every write" — the question is whether the row has to
be brought into being, not whether something is being written.

Every such write runs in the same order, and each step is where it is for a
reason:

```
authentication  →  validation  →  provisioning  →  the write itself
```

- **Authentication comes first, whatever was submitted.** A signed-out visitor
  is sent to sign in rather than told their input was invalid.
- **Provisioning comes after validation.** A submission that is going to be
  rejected must not create the row that saving it would have needed.

Provisioning refreshes what the provider knows — name, email, picture — and
**never the timezone**, so signing in cannot undo a setting the account chose.

**A session carrying no email is turned away rather than invented for.**
`User.email` is `NOT NULL` and unique, so a placeholder would satisfy the
column and hand the constraint a fabricated identity to treat as real. It is
refused exactly like a session with no id.

**Failing to write the row is not failing to authenticate**, and the two leave
differently — the first as a `UserProvisioningError`, the second as a redirect,
which is also thrown. A caller that caught both would show a signed-out visitor
a form error instead of the sign-in page.

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
| Sprint 11 | Timezones, a time of day for scheduled workers, settings | Completed |
| Sprint 12 | A weekday for weekly workers, a day for monthly ones, month-end clamping | Completed |
| Sprint 13 | Documentation sync, and what a failed run does to its schedule | Completed |
| Sprint 14 | PostgreSQL, with a Compose database for local development | Completed |
| Sprint 15 | Documentation sync | Completed |
| Sprint 16 | A schedule module with no database in it | Completed |
| Sprint 17 | Vitest, and unit tests for schedule calculation | Completed |
| Sprint 18 | Atomic slot claiming, so a scheduled slot cannot be dispatched twice | Completed |
| Sprint 19 | Catch-up after an outage — one run to get current, not the backlog | Completed |
| Sprint 20 | An edit that leaves the schedule alone can no longer undo a claim | Completed |
| Sprint 21 | Worker-level failure isolation in the dispatcher | Completed |
| Sprint 22 | Documentation sync | Completed |
| Sprint 23 | Continuous integration on GitHub Actions | Completed |
| Sprint 28 | First production deployment, on Railway (Web Service, PostgreSQL, Cron Service) | Completed |
| Sprint 30 | Worker Status explanation on the create/edit form | Completed |
| Sprint 31 | Long-running execution detection, scheduled-run overdue detection | Completed |
| Sprint 37 | Execution architecture decided — inline stays, and a tick now says how long it took | Completed |
| Sprint 38 | A lease on executing a worker, so a hand-started run and a scheduled one cannot overlap; a test boundary for `server-only` modules | Completed |
| Sprint 39 | A failed run's reason kept apart from its output, and a write that fails no longer recorded as a run that failed | Completed |
| Sprint 40 | The first real execution in production, and tests for the provider boundary and the cron API | Completed |
| Sprint 41 | A dead man's switch on the cron service, so a tick that stops happening is noticed | Completed |
| Sprint 42 | An explicit provisioning boundary, so an account can change its settings before it owns a worker | Completed |
| Sprint 43 | A worker Koqentra runs on its own must have a prompt; template variables stop answering for inherited names; an edit that matched no row stops reporting success | Completed |
| Sprint 44 | A delete that the database refused stops escaping the action, and every tick says when execution last failed | Completed |
| Sprint 45 | Sign-in limited to an invited list, and a privacy notice describing what Koqentra actually keeps | Completed |
| Email Notification MVP | A worker can email its owner when a watched page changes, when a run finishes, or when one fails | Completed |

## Backlog

Known and deliberately deferred — none of these are bugs waiting on a fix.

### Later

**Scheduling**

- Skipped slots are not counted — a worker that resumes after an outage says
  nothing about how many runs it dropped. Recording it needs a column, and no
  screen asks for the number yet
- A worker with no chosen time of day drifts when it catches up: with no
  `runAtMinutes` to anchor to, it resumes at whatever time the recovery
  happened. Workers that have one keep it

**Execution**

- **A slow worker still holds up the ones behind it.** The dispatcher works
  through due workers one at a time, so three minutes spent waiting on a
  provider is three minutes nothing else runs. Per-worker timeouts bound one
  worker, not a tick — five workers may still take fifteen minutes between
  them, and the tick's own budget only stops the next one from *starting*.
  Bounding a tick needs the runs to stop being sequential, which is the real
  queue backend's job
- A run can be left `running` for good. `runRoutine` records the outcome in a
  second write, and if that write is the thing that fails there is nothing left
  to record it with. The row is neither a success nor a failure, and the health
  summary counts it as neither. **Unrelated to timeouts** — a request that times
  out throws, and a throw is recorded like any other failure

- **A run whose outcome could not be written down leaves no record of what it
  did.** The failure is reported rather than stored — see [When the outcome
  cannot be written](#when-the-outcome-cannot-be-written) — so the row keeps
  whatever was last written to it, which is the `running` it was created with.
  Nothing writes it down later: **there is no retry of the write**, and adding
  one raises questions of its own, since a write that threw may have landed
  and repeating it would be guessing which

- Nothing about a failed run says what *kind* of failure it was. The kind is
  worked out at the provider boundary and written to the log; storing it means
  fixing a set of values and what each implies, and **no run has ever failed in
  production**, so there is nothing to fix them against yet

- **Execution stays on the HTTP request, deferred rather than dismissed.**
  Moving it to a resident worker process was evaluated in Sprint 37 and not
  adopted. Two facts decided it: a tick has never had anything to dispatch in
  production, and Railway sends `SIGTERM` with **zero seconds** of grace before
  `SIGKILL`, so a resident worker would lose an in-flight run on every deploy
  from its first day. The problem to be solved is hypothetical; the problem to
  be created is not.

  **Its return is not conditional on execution happening — it is conditional on
  the request lifecycle actually getting in the way:**

  | Stage | Condition |
  | --- | --- |
  | Watch | A tick, or a single execution, reaches **150 seconds** |
  | Reconsider | A single execution reaches **300 seconds**, a cron call fails or goes unanswered, or the request lifecycle constrains something real |

  A tick already reports its duration, so the first row is observable today —
  see [How long a tick took](#how-long-a-tick-took). **A single run no longer
  breaches the second row on its own**: every caller now names a deadline
  shorter than the tick's own budget, so reaching 300 seconds takes several
  slow runs in one tick rather than one. It was one, for as long as a prompt
  worker could ask for ten minutes.

  When it is reconsidered, the **separate process** is the one to look at
  first. Running inside the Next.js server needs no extra service and no extra
  dependency, and cannot shut down cleanly: the framework's own `SIGTERM`
  handler closes the HTTP server and calls `process.exit(0)`, which a worker
  waiting on a model has no way to delay

**Product**

- **A prompt worker can only work on what its prompt already contains, and the
  templates were once written as though it could not.** A prompt worker is one
  model call with the text it holds — no browsing, no search, no inbox, no
  files, no tools, and no sight of what it produced last time. Three of the five
  presets then on offer promised "today's important news", "the unanswered
  emails in my inbox" and "research the topic I am tracking, with sources".
  They were rewritten in the documentation sprint to take pasted material
  instead, and all five moved to `manual` because material carried in the prompt
  does not change on a cadence.

  **The set has since been replaced**, and the boundary it was written against
  has moved for one of the two kinds. Five of the eight examples now make
  website workers, which do see something new — they fetch one named page,
  compare it with the last time, and involve a model only when it differs. The
  three prompt examples keep the rule: each carries the place its material is
  written into, and none of them names a source outside the prompt.

  **What did not change is what a prompt worker can reach.** Nothing in Koqentra
  searches, and a website worker fetches the one address it was given rather
  than going and finding anything. The scheduled examples in
  [Use Cases](./docs/USE_CASES.md) still work because the model generates the
  output rather than fetching it.

  **What follows from the boundary is what a worker cannot be, not what the
  answer has to be.** A worker that needs external information, a worker that
  needs to act on an external system, and a worker that needs an earlier run's
  output carried forward are all outside what execution does today. **How that
  gap might be closed is open** — tool use, fetching or search, connectors,
  carried-forward context, and designs not listed here are all candidates.
  **None of them is chosen.** Approach, scope, priority and timing are all
  undecided, and nothing here should be read as narrowing them to any one of
  these.

- **Koqentra does not check whether model output is true.** A response the
  provider returned normally is recorded as `completed`, and that says the call
  succeeded — not that what came back is correct. Output that is wrong, or
  invented from nothing, is stored the same way as output that is right; a
  worker still holding `(paste headlines or article text here)` completes and
  files a briefing about nothing.

  The templates now instruct the model to use only what it was given and to
  mark gaps rather than fill them. **That is an instruction to the model, not a
  guarantee the platform enforces** — it makes the failure less likely, not
  impossible, and nothing between the provider and `RunHistory` inspects the
  contents either way

**Reading**

- **Run history reaches back twenty runs per screen, and no further.** Activity
  shows the twenty most recent runs of an account; a worker's own page shows the
  twenty most recent of that worker. Between them every recent execution has a
  route to its own page — which is where the reason a failed run gives is shown
  — but a run older than both is still recorded with nothing naming its id. No
  cursor, no paging.

  **The reads themselves are bounded.** Each list takes twenty rows and the
  columns it draws; the summaries beside them are counted by the database over
  the whole history and return one row per worker per status. What used to grow
  with the number of runs stored no longer does — and the counts still mean
  *every* run, which is why the lists and the summaries are read separately.

  **What is left is depth, not boundedness.** A cursor, a paged list, or a
  history page of its own would each reach further, and they answer it
  differently; none is decided. **This is not the scheduler's `take`** — that one
  is about how many due workers a single tick may claim across every tenant, is
  deferred for reasons of its own, and shares nothing with this but the word

**Testing**

- **What the database itself guarantees is still verified by hand.** Tests
  reach schedule arithmetic, the scheduler's query contract, the dispatcher,
  execution and its lease, health and overview, the provider boundary, the cron
  API, the session boundary, form validation and prompt rendering — but every
  one of them stands the database in. That a claim or a lease is atomic, and
  how catch-up behaves against real rows, are things CI passing says nothing
  about. Covering them means a database in CI, which is the cost being deferred
  rather than the coverage

- **What has no test of its own**: every component, and
  `lib/schedule-label.ts`. All five server actions are covered — deleting a
  worker was the last one without, and it gained them alongside the failure
  handling it was missing

**Concurrency**

- Optimistic locking — two tabs editing the same worker still last-write-wins on
  name, description and prompt. `nextRunAt` is no longer among them: the edit
  action leaves the column out of the update unless the schedule changed, so a
  save cannot undo a claim. A `version` column would cover the rest, and is
  deferred until more than one person can edit a worker

**Operational**

- **Deployment.** Resolved in Sprint 28 — Koqentra now runs on Railway (Web
  Service, PostgreSQL, Cron Service), verified end to end:

  | Decision | Resolution |
  | --- | --- |
  | Hosting platform | Railway. The driver adapter's Node APIs work there without changes |
  | Environment variables | Set in the Railway dashboard, per service. `AUTH_URL` is set to the issued domain |
  | Applying migrations | The Web Service's start command is `prisma migrate deploy && next start`, exactly as anticipated. `package.json` was left unchanged |
  | `CRON_SECRET` | Set on both the Web Service and the Cron Service as separate environment variables with the same value |
  | Database hosting | Railway's managed PostgreSQL plugin |
  | Cron execution | A Railway Cron Service, on a 5-minute schedule (Railway's minimum interval — the 1-minute interval originally planned is not available), calling `POST /api/cron/run` |

  One deployment-specific pitfall surfaced and was fixed: a service sourced
  from a Docker image (the Cron Service) runs its start command in **exec
  form**, which does not expand `$CRON_SECRET`. The command needs an explicit
  shell — `/bin/sh -c "..."` — to expand it. Services built from this repo via
  Railpack are unaffected; they already run in a shell.

- **The Claude API works in production, on the evidence of one run.** Sprint 40
  hired a worker there, ran it by hand, and deleted it: the run completed
  against the live model in about five seconds. `ANTHROPIC_API_KEY` is set on
  the Web Service, the startup line announcing the stand-in does not appear,
  and **the key is now known to be accepted** rather than only configured.
  What one run does not establish is how the provider behaves when it goes
  wrong — no run has failed in production, which is why the kinds below are
  still unrecorded.

- **Nothing tells the operator that an execution failed — it has to be looked
  at.** The tick writes [when execution last
  failed](#knowing-whether-the-runs-inside-it-worked) on every pass, so the
  question is answerable from the cron log. **That is a thing to read, not a
  thing that arrives**: there is no webhook, no chat message, and no alert of
  any kind. Building one means deciding how many failures are too many, and
  with no failure ever recorded in production there is nothing to set that
  against — the observation exists partly so that evidence can accumulate.

  **What does arrive is per worker and per owner**, not per platform: an owner
  who turned [email notifications](#email-notifications) on for a worker hears
  about that worker's failures. Nothing aggregates, thresholds or routes
  anywhere, and an account that turned nothing on hears nothing — so the
  operator's question is still the log's to answer

- **The observation has no index behind it.** `RunHistory` is indexed on
  `routineId` and `userId`, so asking for the newest failed row scans rather
  than seeks, once per tick. **No cost has been observed** — at the production
  check on 2026-08-11 the tick reported `last_failed_at=none`, so no failed row
  was found for it to sort through — and it is **not a Closed Beta blocker**,
  but the work grows with the number of runs stored. An index on the two
  columns it filters and sorts by would answer it, which is a schema change and
  so a decision for a sprint that is making one. Neither the shape nor the
  timing is settled

- `削除用/` — things moved aside rather than deleted, kept until Closed Beta
  starts: the database from before the tenant identity fix, the values the
  `schedule` column held before it was dropped, and an empty migration
  directory left behind by a failed generate.
