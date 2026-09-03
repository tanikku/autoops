# Koqentra User Guide

Everything you need to use Koqentra during the Closed Beta.

- [1. What Koqentra is](#1-what-koqentra-is)
- [2. What Koqentra can and cannot do](#2-what-koqentra-can-and-cannot-do)
- [3. Signing in](#3-signing-in)
- [4. Understanding the dashboard](#4-understanding-the-dashboard)
- [5. Creating your first Worker](#5-creating-your-first-worker)
- [6. Using a template](#6-using-a-template)
- [7. Writing a prompt](#7-writing-a-prompt)
- [8. Supplying the information Koqentra needs](#8-supplying-the-information-koqentra-needs)
- [9. Prompt variables](#9-prompt-variables)
- [10. Status](#10-status)
- [11. Frequency](#11-frequency)
- [12. Timezone](#12-timezone)
- [13. Running a Worker manually](#13-running-a-worker-manually)
- [14. Scheduled execution](#14-scheduled-execution)
- [15. Understanding next run time](#15-understanding-next-run-time)
- [16. Viewing Activity](#16-viewing-activity)
- [17. Reading an execution result](#17-reading-an-execution-result)
- [18. Understanding Health](#18-understanding-health)
- [19. Editing a Worker](#19-editing-a-worker)
- [20. Pausing a Worker](#20-pausing-a-worker)
- [21. Deleting a Worker](#21-deleting-a-worker)
- [22. What happens when execution fails](#22-what-happens-when-execution-fails)
- [23. Email notifications](#23-email-notifications)
- [24. Current Closed Beta limitations](#24-current-closed-beta-limitations)
- [25. Privacy](#25-privacy)

---

## 1. What Koqentra is

Koqentra lets you save a prompt once and run it again without retyping it — by
hand whenever you want, or on a daily, weekly, or monthly schedule.

A saved prompt is called a **Worker**. Each Worker has a name, a prompt, and a
frequency. Every time it runs, Koqentra sends its prompt to Claude, stores the
answer, and shows it to you.

That is the whole of it. Koqentra is a scheduler and a record for prompts you
would otherwise be pasting into a chat window each morning.

---

## 2. What Koqentra can and cannot do

**This section is the most important one in the guide.** Nearly every surprise
people have with Koqentra comes from expecting something in the right-hand
column.

### Koqentra can

- Store a prompt and run it on demand
- Run it automatically once a day, once a week, or once a month
- Run it at a time of day in your own timezone
- Substitute today's date or the current timestamp into the prompt
- Keep every result, with the exact prompt that produced it
- Show you which runs succeeded and which failed

### Koqentra cannot

| It cannot | So this will not work |
| --- | --- |
| Browse the web or search | "Summarise today's top stories" |
| Fetch a URL | "Read this page and tell me what changed" |
| Read or send email | "Reply to everything in my inbox" |
| Read your calendar | "Summarise my meetings this week" |
| Post to Slack, Discord, or anywhere else | "Post the result to #general" |
| Reach GitHub, Drive, Sheets, or any other service | "Check the open issues" |
| Open files or images you upload | "Read the attached PDF" |
| Remember what a previous run produced | "Compare this to last week's result" |
| Notify you when something fails | You have to look |
| Retry a failed run | It waits for its next turn |

**A Worker gets exactly the words in its prompt and nothing else.** If a task
needs today's news, this week's emails, or last month's numbers, *you* have to
put them in the prompt.

> **A run that produces something is not the same as a run that produced
> something true.** If you ask for today's headlines, the model may answer
> anyway — from what it learned before it was trained, or by filling in the
> shape of an answer. Koqentra records that as a successful run, because nothing
> in Koqentra can tell the difference. Read [section 8](#8-supplying-the-information-koqentra-needs).

---

## 3. Signing in

1. Open the Koqentra URL you were invited with.
2. Press **Continue with Google**.
3. Choose the Google account you were invited with.

You will land on the dashboard.

**Koqentra is invite-only during the Closed Beta.** Sign-in works only for the
addresses that have been invited. If you try another account, you come back to
the front page with this message:

> Koqentra is in Closed Beta and sign-in is limited to invited accounts.

If you see that with the account you were invited with, contact whoever invited
you — see [Troubleshooting](./TROUBLESHOOTING.md#signing-in).

To sign out, press **Sign out** at the top right of any dashboard page.

---

## 4. Understanding the dashboard

The dashboard is at **Dashboard** in the top navigation, and it has three parts.

### Overview

Five cards summarising your account:

| Card | Means |
| --- | --- |
| **Total Workers** | Every Worker you have, whatever its status |
| **Active Workers** | How many are scheduled to run |
| **Paused Workers** | How many are paused |
| **Next Scheduled Run** | The soonest upcoming run, across Active Workers only |
| **Last Execution** | When a Worker last started running |

If **Next Scheduled Run** shows a time in the past, it adds *Scheduled run is
overdue*. See [section 15](#15-understanding-next-run-time).

### My Workers

One card per Worker, showing its name, status, cadence, Health, and buttons for
**View** and **Run**. Before you have any, it says *No workers yet.* with a
**Hire your first Worker** button.

### Activity

Every run you have had, newest first, each showing the Worker's name, when it
started, and a badge: **Running**, **Completed**, or **Failed**. Click any row
to open its full result.

Before your first run it says *No activity yet. Use Run on a worker to execute
it.*

---

## 5. Creating your first Worker

1. Press **Hire Worker** on the dashboard.
2. Optionally pick a template — see [section 6](#6-using-a-template).
3. Fill in the fields:

| Field | Required | Notes |
| --- | --- | --- |
| **Name** | Yes | Up to 100 characters |
| **Description** | No | Up to 500 characters, for your own reference |
| **Prompt** | Usually | Up to 10,000 characters. See [section 7](#7-writing-a-prompt) |
| **Frequency** | — | Manual, Daily, Weekly, or Monthly |
| **Run at** | No | Time of day, shown for any frequency except Manual |
| **Weekday** | No | Weekly only |
| **Day** | No | Monthly only |
| **Status** | — | Draft, Active, or Paused. Starts on **Draft** |

4. Press **Save**.

You land back on the dashboard with the new Worker in **My Workers**.

**A new Worker starts as a Draft**, so nothing runs until you decide it should.
That is deliberate: you can save a half-finished prompt without it going out on
a schedule.

### If the form will not save

Each field shows its own message below it, the first problem is scrolled into
view, and a toast at the top-right says how many fields need attention. The
counter beside each label turns red if you are over the limit.

---

## 6. Using a template

The **Choose a Template** section on the hire form fills in a name, a
frequency and the instructions for you, and picks the kind of Worker to match.
Everything stays editable afterwards, and nothing is saved until you press
**Save**.

The examples come in two groups, because there are two kinds of Worker.

### Have a page watched for you

These make a **Website Worker**. Koqentra checks the page on the schedule you
choose, and only involves AI when the page has actually changed — then it tells
you what changed.

| Template | Watches | You get, when it changes |
| --- | --- | --- |
| **Watch a local government page** | A council or agency page | What moved on applications, events, dates and procedures |
| **Watch a product page** | A product's own page | Price moves, availability, spec and campaign changes |
| **Watch a company's careers page** | A careers page | Jobs added or taken down, and changed conditions |
| **Watch a news page** | The one news page you give it | What was added, removed or rewritten |
| **Watch a grants page** | A grant or subsidy page | Rounds opening, eligibility, amounts and deadlines |

**You supply the address.** A template cannot know which page you mean, so the
**Website address** field is left empty for you to fill in — the Worker will not
save without it.

**It watches that one page and nothing else.** Koqentra does not search the web,
follow links, or collect from anywhere else. See
[section 2](#2-what-koqentra-can-and-cannot-do).

### Have AI do a job regularly

These make a **Prompt Worker**. There is nothing to check — AI works from the
words in the Worker, every time it runs.

| Template | You write in | You get |
| --- | --- | --- |
| **Plan the day's work** | Today's plans, requests and concerns | Them put in order, with a line on why each comes where it does |
| **Think up ideas regularly** | A theme | Five ideas or improvements, each with a first step |
| **Write a recurring report** | Your material | A report in the same four sections every time |

**A Prompt Worker only knows what you wrote into it.** It has no inbox, no
calendar, no files and no search, so each of these has a marked place for your
material:

```
--- THEME ---
(write yours here)
```

Replace that line with yours. If you leave it as it is, the Worker will still
run, and the result will be about nothing.

**These start on a schedule, and that is a choice you can change.** They are
written around a standing theme rather than around something you supply afresh
each run — but if what you write in only makes sense once, set Frequency to
**Manual** and run it when you have something new.

---

## 7. Writing a prompt

A prompt is the instruction sent to Claude on every run. Write it the way you
would write a message to a capable colleague who cannot look anything up.

What tends to work:

- **Say what you want back**, including the shape: "three bullet points", "under
  150 words", "a table with two columns".
- **Say what to do when something is missing.** "If the notes do not say who
  owns an action, list it as an open question" beats leaving it to chance.
- **Put the material at the end**, under a clear marker, so it is obvious what
  is instruction and what is input.

### When a prompt is required

A prompt is required when a Worker is **Active** *and* its frequency is
**Daily**, **Weekly**, or **Monthly** — in other words, when Koqentra would run
it on its own with nobody watching. Saving one with an empty prompt is refused:

> Prompt is required for scheduled active workers.

A blank prompt is allowed everywhere else — on a **Draft**, on a **Paused**
Worker, and on an **Active** Worker whose frequency is **Manual** — so you can
name something and come back to it.

---

## 8. Supplying the information Koqentra needs

**Koqentra sends your prompt and nothing else.** There is no step where it looks
something up first.

So if the task depends on information that changes, paste that information into
the prompt yourself:

| The task needs | Paste in |
| --- | --- |
| Today's news | The headlines or articles |
| Your emails | The message text |
| A meeting | The notes or transcript |
| A release | The changelog or announcement |
| A comparison | Both versions |
| A document | The relevant text |

This is not a limitation of how well the model writes — it is that Koqentra
never goes and gets anything.

> **This does not mean the model knows nothing.** It can still write, reason,
> summarise, translate, and draw on what it learned during training. The
> boundary is about *fetching*: it cannot see anything that happened after its
> training, and it cannot see anything of yours that is not in the prompt.
>
> The templates say *"Use only what is written below"* because for those tasks
> you want the answer grounded in your material rather than in general
> knowledge. That is an instruction to the model, not a description of what
> Koqentra can reach.

---

## 9. Prompt variables

Two placeholders are filled in at the moment a run starts:

| Write | Becomes | Example |
| --- | --- | --- |
| `{{today}}` | The date | `2026-08-13` |
| `{{now}}` | The full timestamp | `2026-08-13T09:15:00.000Z` |

Both are in **UTC**, not your timezone.

**These two are the only ones.** Anything else stays exactly as you typed it —
`{{yesterday}}` arrives at the model as the literal text `{{yesterday}}`. That
is on purpose: a typo shows up in the output instead of quietly disappearing.

You can see what a run actually sent under **Rendered Prompt** on its result
page.

---

## 10. Status

Set on the **Status** field. The form describes each one as you select it.

| Status | Runs on a schedule | Runs when you press Run |
| --- | --- | --- |
| **Draft** | No | Yes |
| **Active** | **Yes** | Yes |
| **Paused** | No | Yes |

- **Draft** — *Draft workers are not scheduled. Set Status to Active to run
  automatically.* Where a new Worker starts.
- **Active** — *Runs automatically according to its schedule.*
- **Paused** — *Scheduled runs are paused. Manual runs still work.* Use it to
  stop a schedule without losing the Worker.

**You can press Run on any Worker whatever its status.** Status only controls
whether Koqentra starts it for you.

---

## 11. Frequency

| Frequency | Runs |
| --- | --- |
| **Manual** | Never on its own. Only when you press **Run** |
| **Daily** | Once a day |
| **Weekly** | Once a week |
| **Monthly** | Once a month |

Extra fields appear depending on what you pick:

- **Run at** — the time of day, for any frequency except Manual. Leave it empty
  and the Worker keeps whatever time its next run already had.
- **Weekday** — Weekly only. Leave it on the blank option to keep the day it
  already falls on.
- **Day** — Monthly only, 1 to 31, or *Same day it was saved*.

**A day past the end of a month runs on that month's last day**, and the month
after goes back to the day you chose. Ask for the 31st and February runs on the
28th (or 29th), while March runs on the 31st again.

**A Manual Worker never has a next run time**, whatever its status.

---

## 12. Timezone

Go to **Settings** in the top navigation and pick your **Timezone**, then press
**Save**.

Your timezone decides two things:

1. How every time on every screen reads.
2. **What "09:00" means for a scheduled Worker.**

**A new account starts on Asia/Tokyo.** If that is not your zone and you do
not change it, a Worker set to run at 09:00 will run at 09:00 in Tokyo. **Set
your timezone before you create scheduled Workers** — changing it later does
not move the next run of a Worker that already exists.

If your account was created before this default changed, it kept the zone it
had. Settings shows which one that is.

The list covers UTC, Tokyo, Seoul, Singapore, London, Paris, New York, Chicago,
Denver, Los Angeles, and Sydney.

---

## 13. Running a Worker manually

Press **Run** — on the Worker's card on the dashboard, or on its detail page.

The button says **Running…** while it works and a toast tells you the outcome:

| Toast | Means |
| --- | --- |
| *"Name" ran successfully.* | It finished and the result is in Activity |
| *"Name" failed to run.* | It started and something went wrong. The reason is on the result page |
| *"Name" is already running.* | Another run of this Worker is still going. Nothing new was started |
| *"Name" started, but its outcome could not be recorded.* | It reached the model, but the result could not be saved |

**Running takes as long as the model takes.** Stay on the page — the result
appears in Activity when it finishes.

**One Worker runs at a time.** If a scheduled run is in progress and you press
Run, you get *already running* instead of a second run. That protects you from
paying for the same work twice.

**And one Run at a time overall.** While a Worker you started by hand is still
going, pressing Run on a *different* Worker tells you another run of yours is
still in progress. Wait for the first to finish and press it again — nothing is
queued for you, and nothing was started. This applies to prompt and website
Workers alike, and it does not hold up your scheduled runs.

---

## 14. Scheduled execution

Set **Status** to **Active** and **Frequency** to Daily, Weekly, or Monthly.
Koqentra then starts it for you, without you being there.

Koqentra checks for due Workers every five minutes, so **a run may start a few
minutes after the time you chose**. That is normal.

> ### Scheduling does not refresh anything
>
> A scheduled run sends **the same prompt** it sent last time. If that prompt
> contains material you pasted in, running it daily sends those same paragraphs
> every day and gets much the same answer back — and each run costs a call to
> the model.
>
> Scheduling is worth it when the *output* should differ by date: a daily
> planning frame built around `{{today}}`, a weekly checklist, a monthly
> template. It is not worth it for a prompt whose input is fixed.
>
> See [Use Cases](./USE_CASES.md) for examples of both.

**If a Worker misses its slots** — say Koqentra was unavailable for a week — it
does not work through the backlog. It runs once to get current and then carries
on with its normal cadence.

---

## 15. Understanding next run time

A Worker's detail page shows **Next Run**. That is the moment Koqentra intends
to start it next, in your timezone.

It moves forward when a run is claimed, so it always points at the next slot
rather than the one that just went.

If it shows a time in the past, the page adds **Scheduled run is overdue**. That
says the slot has not been taken yet — nothing more. It does not say why, and
the most common reason is simply that the next five-minute check has not come
round.

If it stays overdue for much longer than that, see
[Troubleshooting](./TROUBLESHOOTING.md#my-worker-never-runs-on-its-own).

**Editing a Worker without changing its schedule leaves Next Run alone.**
Changing the frequency, time, weekday, or day recalculates it.

---

## 16. Viewing Activity

**Activity** at the bottom of the dashboard lists your **twenty most recent
runs**, newest first, with the Worker's name, the start time, and a badge:

| Badge | Means |
| --- | --- |
| **Running** | Started, not finished |
| **Completed** | Finished, result stored |
| **Failed** | Started, did not produce a result |

Click a row for the full result.

**The list is not paginated.** Everything you have ever run is on one page, and
it will get longer as you use Koqentra.

---

## 17. Reading an execution result

Clicking an Activity row opens **Execution**, which shows:

| Field | What it is |
| --- | --- |
| **Worker** | Which Worker ran |
| **Status** | Running, Completed, or Failed |
| **Execution Time** | How long it took |
| **Started At** / **Finished At** | In your timezone |
| **Prompt** | The prompt as you wrote it |
| **Rendered Prompt** | What was actually sent, with `{{today}}` and `{{now}}` filled in |
| **Output** | What the model produced — on a successful run |
| **Error** | Why it failed — on a failed run |

**Rendered Prompt is the one to check first when a result surprises you.** It
shows exactly what the model was asked, including whether you left a
`(paste … here)` line in by mistake.

**Koqentra writes its own messages in the language you chose; what a Worker
produced is shown as it was written.** When a website check finds nothing new,
the line you see is Koqentra speaking and follows your Language setting — even
for runs from before you changed it. Anything a model wrote is left exactly as
it came back, whichever language that is.

---

## 18. Understanding Health

Each Worker card and detail page shows **Health**:

- The latest result — **Success**, **Failed**, **Running**, or **Never run** —
  and when it was
- A count: *3 runs · 1 failure*

If the newest run has been **Running** for more than fifteen minutes, Health
adds **Running for longer than expected**. That is a note, not a diagnosis: a
genuinely slow run and a run that will never finish look the same from here.

Below Health, **Run History** lists that Worker's twenty most recent runs — the
time each started and how it ended. Clicking one opens its **Execution** page,
which is where a failed run's **Error** is shown.

---

## 19. Editing a Worker

Open the Worker and press **Edit**, change what you need, and press **Save**.
You come back to the detail page.

- **Changing name, description, or prompt does not touch the schedule.** The
  next run stays where it was.
- **Changing the frequency, time, weekday, or day recalculates the next run.**
  Switching to Manual removes it entirely; switching away from Manual creates
  the first one.
- **Making an Active scheduled Worker's prompt empty is refused** — see
  [section 7](#7-writing-a-prompt). Set it to Draft in the same save if you want
  to clear the prompt.

Deleting is not on the edit page. It is on the detail page — see
[section 21](#21-deleting-a-worker).

---

## 20. Pausing a Worker

Edit the Worker, set **Status** to **Paused**, and press **Save**.

Scheduled runs stop. **Run still works.** The schedule is kept, so setting it
back to **Active** resumes it.

Use **Draft** instead if you want to signal that a Worker is unfinished rather
than deliberately stopped. Both behave the same for scheduling.

---

## 21. Deleting a Worker

At the bottom of a Worker's detail page there is a **Danger zone**. Press
**Delete** and confirm.

> **Deleting a Worker also deletes every run it ever had. This cannot be
> undone**, and there is no archive to restore from.

If you only want it to stop running, pause it instead.

---

## 22. What happens when execution fails

A failed run is recorded, not lost:

- It appears in **Activity** with a red **Failed** badge
- Its **Health** failure count goes up
- Its result page shows **Error** with the reason the failure carried

**Nothing is retried.** A failed scheduled run does not run again immediately —
the Worker comes round at its next slot. If you want it sooner, press **Run**.

**You are told only if you asked to be.** Turn on **Email notifications** for a
Worker and a failed run emails you — see
[section 23](#23-email-notifications). With it off, you find out by looking at
Activity or at a Worker's Health.

**A failed run does not shift the schedule.** The next run stays where it was
going to be.

The **Error** text is whatever the failure said, in the wording it arrived with.
It is written for diagnosis rather than for reading comfortably.

---

## 23. Email notifications

**Off unless you turn it on, and you turn it on for one Worker at a time.**
There is an **Email notifications** checkbox when you create a Worker and when
you edit one. Tick it, save, and Koqentra emails you about that Worker's runs.

**Messages go to the address on your account** — the one you signed in with.
There is nowhere to type a different address, and there is no way to add a
second recipient.

**Not every run sends one:**

| What happened | Email |
| --- | --- |
| A Worker watching a page finds it changed | **Yes** — with what the AI made of the change |
| The page had not changed | No |
| The first check, which records what the page looks like now | No |
| A Worker that runs a prompt finishes | **Yes** — with what it produced |
| A run fails | **Yes** |

**A page that has not changed sends nothing on purpose.** A Worker checking a
page every day would otherwise email you every day to say nothing happened.

**A failure email says the run failed and links to it.** The reason is on the
result page in the app rather than in the message.

**Long results are cut short.** A message carries the first part of what the
run produced and says the rest is in Koqentra. The full result is always on the
result page.

**A message that cannot be delivered does not affect the run.** If sending
fails for any reason, the run keeps its result exactly as it was recorded —
nothing is lost from Koqentra, and the result page is still there. **Nothing is
sent twice and nothing is retried**, so a message that never arrives is not
resent later.

**Emails come in the language your account is set to**, but what a Worker
produced is never translated — it arrives exactly as it was stored.

---

## 24. Current Closed Beta limitations

Beyond the capability boundary in [section 2](#2-what-koqentra-can-and-cannot-do):

| Limitation | Detail |
| --- | --- |
| **Invite only** | Sign-in is limited to invited addresses |
| **Ten AI drafts an hour** | Asking Koqentra to write a Worker for you is limited to ten requests an hour per account |
| **Email notifications only** | Email is the only thing Koqentra sends anywhere, it is off unless you turn it on per Worker, and it goes to your account's address. There is no Slack, no chat, no phone notification, no webhook, and no daily summary |
| **Nothing is sent twice** | A message is attempted once. If it cannot be delivered, it is not retried and not sent later — the result is still in Koqentra |
| **No retry** | A failed run waits for its next slot |
| **Each run list shows the newest twenty** | Activity shows an account's, a Worker's page shows that Worker's. No paging, no filtering, no search — older runs are kept, and nothing lists them |
| **Runs are kept indefinitely** | Nothing expires. Deleting a Worker deletes its runs |
| **No account deletion** | There is no button to delete your whole account. Deleting each Worker removes those Workers and their runs |
| **Manual and scheduled runs look identical afterwards** | A result does not record which one started it |
| **Five-minute granularity** | The soonest a scheduled run can start after its time |
| **Text only** | No file upload, no images, no attachments |
| **Twenty Workers per account** | Drafts, paused and active Workers all count. Delete one to make room |
| **Ten active Workers per account** | Pause one to activate another. A Worker set to Active counts even if its schedule is Manual |
| **One run per Worker at a time** | A second attempt is refused while one is in progress |
| **One manual run at a time** | Pressing Run while a Worker you started by hand is still going is refused, whichever Worker it is |
| **Twenty manual runs an hour** | Per account, counted from the first run of the hour. A run that fails still counts. Scheduled runs are not counted against it |
| **One visit to a site at a time** | Koqentra does not fetch the same website twice in quick succession, whoever asked. A run that arrives while the site was just checked waits briefly, and is recorded as failed if its turn does not come |
| **Availability is not guaranteed** | It is a beta; runs may be missed |

---

## 25. Privacy

What Koqentra stores, where it goes, and what it does not do is at
the **`/privacy`** page in the app — reachable from the **Privacy** link in the
footer of the front page.

The short version: your prompts are stored, they are sent to Anthropic to be
run, results are kept until you delete the Worker, and there is no automatic
expiry. If you turn [email notifications](#23-email-notifications) on for a
Worker, your address and part of what that Worker produced also go to the
service that sends the message.

---

Something not covered here? Try **[Troubleshooting](./TROUBLESHOOTING.md)** or
**[Use Cases](./USE_CASES.md)** — or write to us. The support address is under
**Settings** once you are signed in.
