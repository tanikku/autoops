# Koqentra Troubleshooting

Symptoms, what causes them, and what to do. If your problem is that a Worker
produced something useless rather than something broken, start at
[Results](#results) — that is the most common case and it is usually not a bug.

- [Signing in](#signing-in)
- [Saving a Worker](#saving-a-worker)
- [Scheduling](#scheduling)
- [Running](#running)
- [Results](#results)
- [Deleting](#deleting)
- [For the Closed Beta operator](#for-the-closed-beta-operator)

---

## Signing in

### "Koqentra is in Closed Beta and sign-in is limited to invited accounts."

Your Google account is not on the beta invite list. This is the expected
message for an uninvited account — nothing is broken.

Nothing was created for you: no session, no account record, no data. Ask the
person running the beta to add the address you signed in with.

If you have **more than one Google account**, check which one the browser
used. The invite is tied to one specific address, and Google will silently pick
whichever account you are already signed in to.

### Sign-in returns to the front page with nothing to show for it

Two different causes look identical:

- **Your account is not invited** — but you missed the message above. It
  appears in the middle of the front page, under the tagline.
- **You cancelled the Google consent screen**, or it timed out.

Try **Continue with Google** again and read the front page carefully before
clicking anything.

### I was signed in yesterday and now I am not

Sessions expire after a period of inactivity. Sign in again. Your Workers and
their history are unaffected — they belong to the account, not the session.

---

## Saving a Worker

### "Prompt is required for scheduled active workers."

You are trying to save a Worker that Koqentra would run **unattended and
repeatedly**, with an empty prompt. That combination is rejected, because an
empty prompt scheduled daily is a request to call the model every day for
nothing.

The rule is exactly this combination:

| Status | Frequency | Empty prompt |
| --- | --- | --- |
| Draft | any | allowed |
| Paused | any | allowed |
| Active | Manual | allowed |
| **Active** | **Daily / Weekly / Monthly** | **rejected** |

Any of these fixes it: write the prompt, set **Status** to *Draft*, or set
**Frequency** to *Manual*.

**A prompt is not required in general.** You can save an empty draft and come
back to it.

### "Name is required."

The **Name** field is blank, or contains only spaces.

### The form rejects a field for being too long

Length limits: **Name** 100 characters, **Description** 500, **Prompt** 10,000.
The prompt limit is the one people hit — usually when pasting a long document
in. Trim the material to the part that actually matters; it generally improves
the result too.

### "Could not create the worker." / "Could not save the worker."

The save failed on the server side, not in your input. **Nothing was saved.**

Try again. If it keeps happening, it is not something you can fix from the
form — report it to whoever is running the beta.

### "Worker not found."

The Worker you were editing no longer exists. The usual cause is that it was
deleted in another tab or on another device while this form was open.

**Your edit was not saved and cannot be recovered from this screen.** Go back
to the dashboard to confirm what still exists.

### "Could not save your timezone." / "Select a timezone from the list."

The second one means the value was not one of the eleven supported zones —
pick from the dropdown rather than typing. The first is a server-side failure;
retry, and your existing timezone remains unchanged in the meantime.

---

## Scheduling

### My Worker never runs on its own

Work through these in order — the first three account for almost every case:

1. **Status is Draft or Paused.** Only **Active** Workers are scheduled. Draft
   says so directly on the form: "Draft workers are not scheduled."
2. **Frequency is Manual.** Manual means *only* when you press **Run**. It is
   not a schedule.
3. **The first run has not come round yet.** Check **Next Scheduled Run** on
   the Overview, and remember it is shown in your chosen timezone.
4. **The prompt is empty** — though you cannot save that combination, so this
   only applies to Workers saved before that rule existed.

### "Scheduled run is overdue"

The Worker is Active with a scheduled time that has passed, and it has not been
picked up yet.

**This message does not tell you why.** It is deliberately worded not to guess.
It can mean the scheduling service is not running, or simply that the run is
minutes away from being collected. A few minutes of overdue is normal; hours is
not.

If it persists, tell the person running the beta — it is not something you can
resolve from the dashboard.

### Next Scheduled Run is empty

Expected when no Worker is both **Active** and on a **Daily / Weekly /
Monthly** frequency. Manual Workers have no next run by definition.

### It ran at the wrong time

- **Check your timezone in Settings.** Schedules are interpreted in the
  timezone on your account, not your browser's. A new account starts on **UTC**
  until you change it.
- **Daylight saving.** A Worker set to 09:00 keeps running at 09:00 on your
  clock across a DST change — that is the intended behaviour, and it means the
  UTC instant shifts by an hour.
- **You did not set a time.** With **Run at** left empty, the time of day comes
  from when the Worker was saved.

### My monthly Worker moved to a different day

A monthly Worker set to a day that some months do not have — the 31st, or the
29th to 31st in February — is moved to the last day of the short month.

**It does not move back on its own.** If the original day was not recorded in
the **Day** field, Koqentra has no way to know what you meant, so the shifted
date sticks. Fix it by editing the Worker and setting **Day** explicitly — then
the intended day is stored and applied every month.

---

## Running

### Nothing happens when I press Run

The button changes to **Running…** while the request is in flight. A model call
usually takes several seconds and can take much longer for a long prompt. Wait
for the toast before pressing again.

### "…is already running."

That Worker has an execution in progress, and Koqentra will not start a second
one alongside it. This is a safeguard, not an error — the run already underway
is unaffected.

The most common trigger is pressing **Run** on a Worker that a scheduled run
just picked up. Wait, then check Activity.

### "…started, but its outcome could not be recorded."

**This one is worth reading carefully.** The execution began — quite possibly
successfully — but Koqentra could not write the result down.

That means:

- The model may well have been called, and **billed**.
- The output is **gone**. It was not saved anywhere.
- The run is left showing as **Running** and will not update on its own.

There is nothing to recover. If you need the output, run the Worker again.

### A run has said "Running" for a long time

After about fifteen minutes, Health shows **"Running for longer than
expected"**. That phrasing is deliberate: Koqentra genuinely cannot tell a slow
run from one whose result was lost, so it does not claim the run failed.

If the row is hours old, treat it as lost and run again.

---

## Results

### The output is generic, or about nothing at all

**Almost always: the placeholder is still in the prompt.**

Every built-in template contains a line like `(paste headlines or article text
here)`. If you run the Worker without replacing it, the model is asked to
summarise a parenthetical instruction — and it will produce *something*, which
Koqentra records as a **successful** run.

Open the Worker, replace the `(paste …)` line with real material, and run
again. See [Supplying the information Koqentra
needs](./USER_GUIDE.md#8-supplying-the-information-koqentra-needs).

### The output says it cannot access my email / the news / a website

That is correct, and the model is telling you the truth.

**Koqentra sends your prompt and nothing else.** No browsing, no search, no
mailbox, no calendar, no files, no other tools. A prompt that says "check my
inbox" or "look up today's headlines" is asking for something that cannot
happen. Paste the material in instead.

### The output contains facts I never gave it, and they are wrong

The model filled a gap. It has no source to check against, so anything not in
your prompt is invention.

Two things reduce it: put the material in the prompt, and tell the model what
to do when something is missing. The built-in templates do this — *"Use only
what is written below"*, *"leave a clearly marked gap instead of inventing
it"*. Keep those lines when you edit a template.

**They are an instruction to the model, not a guarantee from Koqentra.** They
make invention less likely, not impossible. Check anything that matters.

### A scheduled Worker keeps sending me the same thing

A Worker cannot see what it produced last time. There is no memory between
runs, so a fixed prompt tends toward similar output, and asking for "what
changed since yesterday" cannot work at all.

For comparisons, paste both versions into one prompt — see [use case
5](./USE_CASES.md#5-what-changed-between-these-two-versions).

### A run failed — where do I find out why?

Open **Activity**, click the run, and read the **Error** field. It only appears
on failed runs.

Common shapes:

| What it suggests | What to do |
| --- | --- |
| A timeout | The prompt was probably too large or the model too slow. Shorten it and retry |
| Rate limiting or unavailability | A temporary condition on the model provider's side. Retry later |
| Authentication or configuration | Not something you can fix. Report it |

**There is no automatic retry.** A failed scheduled run is not attempted again
before its next scheduled slot. Use **Run** if you need it sooner.

### Nothing told me the run failed

**Check whether that Worker has Email notifications turned on.** It is off
unless somebody turned it on, and it is set per Worker — see
[Email notifications](./USER_GUIDE.md#23-email-notifications). With it off,
failures are visible in **Activity** and in each Worker's **Health** and only
there, and you have to look.

With it on and still nothing arriving, the message may not have been delivered.
**Koqentra does not retry and does not send it later**, and a delivery that
failed changes nothing about the run: the result is in Activity exactly as it
was recorded. Ask whoever operates the deployment to check the log for
`[notify] could not send`.

### Rendered Prompt looks different from my prompt

That is the point of the field. **Prompt** is what you wrote; **Rendered
Prompt** is what was actually sent, with `{{today}}` and `{{now}}` filled in.

Anything else in double braces — `{{topic}}`, say — is left exactly as written
and sent through as literal text, because only those two variables exist.

---

## Deleting

### "Could not delete the worker."

The deletion failed on the server. **The Worker still exists** and its history
is intact. Refresh the dashboard and try again.

### The Worker is gone but I wanted its history

Deleting a Worker deletes its run history with it, permanently, and Koqentra
does not ask twice. Copy anything you need out of Activity before deleting.

---

## For the Closed Beta operator

This section is about running the deployment, not using the app.

### Is the scheduler alive?

An external dead man's switch (Healthchecks.io) pings on every successful cron
tick. It is configured with a **5-minute period and a 15-minute grace**, so a
stopped scheduler surfaces roughly twenty minutes after the last good tick.

**It watches infrastructure, not executions.** The heartbeat means "the cron
container ran and the cron endpoint returned 2xx". A tick in which a Worker's
execution failed still sends a heartbeat, by design — monitoring must not
redefine what a successful tick is.

### Did any execution fail?

Every tick logs one line:

```
[cron] execution failures — last_failed_at=none
[cron] execution failures — last_failed_at=<ISO 8601>
```

Read it as: **the timestamp of the most recent failed run across all
accounts**, or `none` if there is no such row.

Things it is easy to get wrong about this line:

- **It is not a notification.** Nothing is sent anywhere. Someone has to read
  the log.
- **It has no window and no count.** It reports the latest failure, full stop —
  not how many, and not "in the last hour".
- **It repeats.** The same timestamp prints every tick until a newer failure
  occurs. That is intended, not a stuck log.
- **It prints every tick, including `none`.** A line that appeared only on
  failure would make "no failures" and "the check stopped running"
  indistinguishable.

### Is the dispatcher receiving work?

```
[dispatcher] due workers — count=N
[cron] tick finished — duration_ms=… dispatched=… failed=…
```

Together these separate three situations that otherwise look the same: the tick
is not running at all, it is running but nothing is due, or it is running with
work that is failing to hand off.

Note that `failed` here counts **workers that could not be started**, not
executions that ran and failed. Those are different numbers and this one does
not include the other.

### Someone was invited but still cannot sign in

The allowlist is read from an environment variable **once at process start**.
Adding an address takes effect only after a redeploy or restart.

Check the ordering rule when changing it: **set the variable first, deploy the
code second.** Admission is fail-closed, so an unset or empty list denies
everyone.

### Removing someone from the allowlist did not sign them out

It would not. Sessions are self-contained tokens with no server-side store, so
an already-issued session stays valid until it expires.

**The allowlist controls who can sign in next, not who is signed in now.**

### An owner says their email notifications are not arriving

Look for this line, one per message that was not sent:

```
[notify] could not send run=<id> worker=<id> reason=<...>
```

| `reason` | What it means |
| --- | --- |
| `not-configured` | `RESEND_API_KEY` or `EMAIL_FROM` is not set on the web service |
| `link-unavailable` | `AUTH_URL` is unset or is not an address a link can be built from |
| `recipient-unknown` | The owner's row or address could not be read |
| `timeout` / `network` | The provider did not answer |
| `rejected` | The provider answered and refused it — check the sending domain is verified |
| `unreadable` | A success whose body was not what the API documents |

**No line at all means nothing was attempted.** Either the Worker does not have
notifications on, or the run was one that does not send: a website check that
found nothing, a first check, or a fetch Koqentra declined because it had asked
that host a moment ago.

**Nothing here changes a run.** A message that could not be sent leaves the
run's status, its result and its schedule exactly as they were, and there is no
retry — the owner still has the result in the app.

**The line names two ids and a reason and nothing else.** No address, no key,
no provider response, and nothing the Worker produced.

### There is no admin view

By design, for now. There are no roles and no cross-account screens: an
operator cannot see another account's Workers, prompts, or outputs through the
app. Operational visibility is the cron log lines above.

---

**Still stuck?** The support address is under **Settings** once you are signed
in. Koqentra is in Closed Beta, and hearing about it is the point.

See also: **[User Guide](./USER_GUIDE.md)** · **[Use Cases](./USE_CASES.md)**
