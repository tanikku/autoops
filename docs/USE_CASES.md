# AutoOps Use Cases

Worker setups that work with what AutoOps can actually do today. Every prompt
here is ready to copy and paste.

Before using these, it is worth knowing the one rule they are all built around:

> **AutoOps sends your prompt and nothing else.** It does not browse, search,
> read email, or open files, and it does not remember what a previous run
> produced. Anything a task depends on has to be *in* the prompt.

See [What AutoOps can and cannot do](./USER_GUIDE.md#2-what-autoops-can-and-cannot-do).

---

## Two kinds of Worker

That rule splits useful Workers into two groups, and knowing which one you are
building saves a lot of confusion:

| | **You bring the material** | **The model generates it** |
| --- | --- | --- |
| Frequency | **Manual** | **Daily / Weekly / Monthly** |
| Input | Something you paste in each time | Nothing — the prompt is self-contained |
| Why schedule it? | No reason to. The paste is the work | The point is getting something new each time |
| Examples | [1](#1-brief-me-on-these-articles)–[5](#5-what-changed-between-these-two-versions) | [6](#6-daily-language-practice)–[9](#9-monthly-planning-frame) |

**Scheduling a Worker whose material is pasted in sends the same paragraphs
again and gets much the same answer back — and bills a model call for it.** Keep
those on Manual.

---

# Manual Workers — you bring the material

These are written out here rather than offered as templates: each one works on
material you paste in for that run, so it belongs on **Manual** frequency. Every
Worker starts as a **Draft** whichever way you make it, so nothing runs before
you are ready.

**The built-in templates are a different set** — five for watching a page and
three for asking a model on a schedule. See
[Using a template](./USER_GUIDE.md#6-using-a-template).

---

## 1. Brief me on these articles

**What it does** — Turns a pile of headlines or article text into a short
briefing you can read in a minute.

| | |
| --- | --- |
| **Manual or Scheduled** | Manual |
| **Suggested status** | Draft, or Active — either is fine, since Manual never runs on its own |
| **Suggested frequency** | Manual |

**Prompt**

```
Today is {{today}}.

Write a short briefing from the articles below: the three or four things that matter most, one sentence each, then anything worth watching.

Use only what is written below. If something is unclear, say so rather than filling it in.

--- ARTICLES ---
(paste headlines or article text here)
```

**What you must provide** — The articles. Paste headlines, summaries, or full
text over the `(paste …)` line. Nothing happens automatically.

**Expected output** — Three or four one-sentence points, then a short "worth
watching" list.

**Important limitation** — AutoOps does not fetch the articles. If you leave the
placeholder in, the run still succeeds and the briefing will be about nothing.

---

## 2. Draft social posts from an update

**What it does** — Turns a release note or announcement into a few short posts.

| | |
| --- | --- |
| **Manual or Scheduled** | Manual |
| **Suggested status** | Draft |
| **Suggested frequency** | Manual |

**Prompt**

```
Write three X posts about the update below. Keep each under 280 characters, avoid hashtags, and give each one a different angle so they are not three versions of the same sentence.

Use only what is written below.

--- UPDATE ---
(paste your announcement, release notes or changelog here)
```

**What you must provide** — The update text.

**Expected output** — Three distinct posts under 280 characters.

**Important limitation** — AutoOps writes the posts. **It does not publish
them** — there is no connection to X or any other platform. Copy them out
yourself.

---

## 3. Draft replies to these emails

**What it does** — Produces a reply draft for each message you paste in.

| | |
| --- | --- |
| **Manual or Scheduled** | Manual |
| **Suggested status** | Draft |
| **Suggested frequency** | Manual |

**Prompt**

```
Draft a reply to each email below. Keep each under 150 words, match the tone of the message it answers, and separate the drafts with a blank line.

Use only what is written below. Where a reply needs something that is not there, leave a clearly marked gap instead of inventing it.

--- EMAILS ---
(paste the emails you need to answer here)
```

**What you must provide** — The email text. Paste the messages you want
answered.

**Expected output** — One draft per email, each under 150 words, with marked
gaps where facts are missing.

**Important limitation** — AutoOps has **no access to your mailbox** and cannot
send anything. Consider what you paste in: it is stored with the Worker and
sent to Anthropic. See [Privacy](./USER_GUIDE.md#25-privacy).

---

## 4. Turn meeting notes into decisions and actions

**What it does** — Structures rough notes into decisions, action items, and open
questions.

| | |
| --- | --- |
| **Manual or Scheduled** | Manual |
| **Suggested status** | Draft |
| **Suggested frequency** | Manual |

**Prompt**

```
Turn the notes below into three sections: decisions made, action items with an owner for each, and open questions.

Use only what is written below. If an action item has no clear owner, put it under open questions rather than guessing.

--- NOTES ---
(paste your meeting notes or transcript here)
```

**What you must provide** — The notes or transcript.

**Expected output** — Three headed sections, with unowned actions surfaced as
open questions rather than assigned to someone at random.

**Important limitation** — AutoOps cannot reach your calendar or any meeting
tool. The notes have to come from you.

---

## 5. What changed between these two versions?

**What it does** — Compares two versions of the same material and reports the
difference.

| | |
| --- | --- |
| **Manual or Scheduled** | Manual |
| **Suggested status** | Draft |
| **Suggested frequency** | Manual |

**Prompt**

```
Generated at {{now}}.

Compare the two sets of notes below and report what changed: what is new, what has gone, and what is still there but reads differently. Finish with a short conclusion.

Use only what is written below. Do not add anything from elsewhere.

--- EARLIER ---
(paste the earlier version here)

--- CURRENT ---
(paste the current version here)
```

**What you must provide** — **Both** versions. This is the important one.

**Expected output** — What is new, what has gone, what reads differently, and a
short conclusion.

**Important limitation** — **AutoOps cannot compare this run to the last one.**
It has no memory between runs, so "what changed since last time" only works if
you paste both sides in yourself.

---

# Scheduled Workers — the model generates it

Scheduling earns its place when you want **something new each time** and nothing
outside AutoOps is needed to produce it. The prompt stays fixed; what varies is
what the model writes.

**These four need no pasted material and no external data.** They are the cases
where "run this every morning" genuinely means something.

> **One caveat applies to all of them.** A Worker cannot see its own past
> output, so it does not know what it gave you yesterday. Over weeks you will
> see repeats. Asking for variety in the prompt helps; it does not eliminate it.

---

## 6. Daily language practice

**What it does** — Gives you a small set of fresh practice sentences every
morning.

| | |
| --- | --- |
| **Manual or Scheduled** | **Scheduled** |
| **Suggested status** | **Active** |
| **Suggested frequency** | **Daily**, with **Run at** set to a time you will actually read it |

**Prompt**

```
Today is {{today}}.

Give me five Japanese practice sentences at JLPT N3 level about everyday work situations.

For each one: the Japanese sentence, a natural English translation, and one short note about a word or grammar point in it.

Vary the topics and grammar patterns. Do not number the notes; keep each sentence block short enough to read on a phone.
```

**What you must provide** — Nothing. Edit the language, level, and topic to
suit you.

**Expected output** — Five sentence blocks, each with a translation and a note.

**Important limitation** — The Worker does not know what it sent you yesterday,
so sentences and grammar points will repeat over time. It also cannot check
your answers or track your progress.

---

## 7. Daily practice problem

**What it does** — One self-contained exercise each morning, without the
solution.

| | |
| --- | --- |
| **Manual or Scheduled** | **Scheduled** |
| **Suggested status** | **Active** |
| **Suggested frequency** | **Daily** |

**Prompt**

```
Today is {{today}}.

Give me one medium-difficulty algorithm problem to solve by hand.

Include: the problem statement, the input and output format, one small worked example, and one hint.

Do not include the solution. Keep it to something that fits in about thirty minutes.
```

**What you must provide** — Nothing.

**Expected output** — A statement, a format, an example, and a hint.

**Important limitation** — No memory between runs, so problems will repeat
eventually. It cannot mark your answer or adapt to what you found difficult.

---

## 8. Weekly retrospective agenda

**What it does** — A fresh set of discussion prompts for a recurring team
meeting, so the retro does not become the same four questions forever.

| | |
| --- | --- |
| **Manual or Scheduled** | **Scheduled** |
| **Suggested status** | **Active** |
| **Suggested frequency** | **Weekly**, with **Weekday** and **Run at** set an hour or two before the meeting |

**Prompt**

```
Week of {{today}}.

Write an agenda for a 45-minute retrospective for a small software team.

Include: a two-minute opener, four discussion prompts that are not the usual "what went well / what went badly", a ten-minute slot for picking actions, and a one-line closing question.

Give a rough timing for each part. Keep the prompts specific enough to answer without preparation.
```

**What you must provide** — Nothing. Adjust the length and team type.

**Expected output** — A timed agenda with four fresh discussion prompts.

**Important limitation** — It knows nothing about your team, your last retro, or
what you actually decided. It produces a *frame*; the content comes from the
meeting.

---

## 9. Monthly planning frame

**What it does** — A structured page to fill in at the start of each month.

| | |
| --- | --- |
| **Manual or Scheduled** | **Scheduled** |
| **Suggested status** | **Active** |
| **Suggested frequency** | **Monthly**, with **Day** set to 1 |

**Prompt**

```
Month starting {{today}}.

Write a monthly planning page for me to fill in, with these sections:

- Three outcomes that would make this month a good one
- What I am deliberately not doing this month
- One thing I have been putting off
- A weekly checkpoint question

Under each heading, leave the space for me to write and add one short prompting question to get me started. Do not fill in the answers.
```

**What you must provide** — Nothing.

**Expected output** — A blank-but-guided planning page dated to the month.

**Important limitation** — It cannot see last month's page or whether you did
any of it. Every month starts from nothing.

---

## What is deliberately not here

Some obvious-sounding Workers cannot be built with AutoOps today. They are left
out rather than written up with a warning:

| Not possible | Why |
| --- | --- |
| A digest gathered from across the news | AutoOps searches nothing. A **Website** Worker watches one page you name, and [#1](#1-brief-me-on-these-articles) works from articles you paste in |
| Monitoring a website with a **Prompt** Worker | It has no HTTP access and no memory of the previous check. A **Website** Worker does both — see [Using a template](./USER_GUIDE.md#6-using-a-template) |
| An inbox summary each morning | No mailbox access. Use [#3](#3-draft-replies-to-these-emails) and paste the messages |
| A weekly report from your project tracker | No GitHub, no Sheets, no external database |
| Posting anything anywhere | AutoOps writes text. It does not send it |
| "Tell me what changed since last run" | A Worker cannot see its own history. Use [#5](#5-what-changed-between-these-two-versions) and paste both versions |
| Alerting you anywhere but by email | Email is the only thing AutoOps sends, it is off unless you turn it on per Worker, and it goes to your account's address — see [Email notifications](./USER_GUIDE.md#23-email-notifications) |

**Every example on this page is written out by hand rather than taken from a
template.** The built-in templates cover different ground — watching a page, and
asking a model on a schedule — and are described in
[Using a template](./USER_GUIDE.md#6-using-a-template).

---

See also: **[User Guide](./USER_GUIDE.md)** · **[Troubleshooting](./TROUBLESHOOTING.md)**
