/**
 * The English copy, and the shape every other language is held to.
 *
 * **This file is the source of truth twice over.** It carries the words English
 * readers see, and — because `TranslationKey` is derived from its keys — it also
 * decides what a translation is allowed to contain. A key added here without a
 * Japanese counterpart is a type error in `ja.ts`, and a key only Japanese has
 * cannot be written at all.
 *
 * **Keys are flat and dotted rather than nested objects.** A nested shape reads
 * better in a file and worse everywhere else: `t()` would need a path walker,
 * missing keys would surface as `undefined` at runtime instead of at the type
 * level, and the parity check would have to recurse. Flat keys make
 * `keyof typeof en` the whole contract.
 *
 * **Named by what the words are for, not where they sit.** `common.status.*`
 * survives a status badge appearing on a second screen; `dashboardCard.badge2`
 * does not.
 *
 * **`{placeholders}` are filled by `t`.** Where a sentence wraps a number, the
 * number is a variable rather than two strings glued together — the parts do
 * not sit in the same order in every language.
 */
export const en = {
  "nav.dashboard": "Dashboard",
  "nav.settings": "Settings",
  "nav.signOut": "Sign out",
  /** Stands in for a name the provider did not give us. */
  "nav.signedIn": "Signed in",

  "dashboard.title": "My AI Team",
  "dashboard.description": "Manage and monitor your AI workers.",
  "dashboard.hireWorker": "Hire Worker",
  "dashboard.overview": "Overview",
  "dashboard.workers": "My Workers",
  "dashboard.empty": "No workers yet.",
  "dashboard.hireFirstWorker": "Hire your first Worker",
  "dashboard.activity": "Activity",
  "dashboard.activityEmpty": "No activity yet. Use Run on a worker to execute it.",

  "overview.total": "Total Workers",
  "overview.active": "Active Workers",
  "overview.paused": "Paused Workers",
  "overview.nextScheduledRun": "Next Scheduled Run",
  "overview.noneScheduled": "None scheduled",
  "overview.overdue": "Scheduled run is overdue",
  "overview.lastExecution": "Last Execution",
  "overview.neverExecuted": "Never",

  "worker.nextRun": "Next Run",
  /** A worker with no pending slot: it runs when somebody asks. */
  "worker.manual": "Manual",
  "worker.view": "View",
  "worker.run": "Run",
  "worker.running": "Running…",

  /**
   * What a worker is doing, as a badge.
   *
   * The stored values are `active` / `paused` / `draft` and they do not change:
   * these are what those values are called on screen, which is a different
   * question and the only one a language can answer.
   */
  "common.status.active": "Active",
  "common.status.paused": "Paused",
  "common.status.draft": "Draft",

  /** What one execution ended as. Stored as `running` / `completed` / `failed`. */
  "common.runStatus.running": "Running",
  "common.runStatus.completed": "Completed",
  "common.runStatus.failed": "Failed",

  "health.title": "Health",
  /**
   * How the last run reads in a health summary.
   *
   * Deliberately not the same words as `common.runStatus.*`: a run is
   * `Completed`, and a worker whose last run completed is `Success`. Sharing
   * one set would change what one of the two screens says.
   */
  "health.success": "Success",
  "health.failed": "Failed",
  "health.running": "Running",
  "health.neverRun": "Never run",
  "health.stuck": "Running for longer than expected",
  "health.runs.one": "{count} run",
  "health.runs.other": "{count} runs",
  "health.failures.one": "{count} failure",
  "health.failures.other": "{count} failures",

  /**
   * How a cadence reads.
   *
   * `schedule.onDay` is given both an ordinal and a plain number, and each
   * language uses the one it needs — "the 3rd" is an English rule, and a
   * Japanese sentence that borrowed it would read as a typo.
   */
  "schedule.manual": "Manual execution",
  "schedule.daily": "Every day",
  "schedule.weekly": "Every week",
  "schedule.monthly": "Every month",
  "schedule.everyWeekday": "Every {day}",
  "schedule.onDay": "On the {ordinal}",
  "schedule.atTime": "{cadence} at {time}",

  "common.weekday.sunday": "Sunday",
  "common.weekday.monday": "Monday",
  "common.weekday.tuesday": "Tuesday",
  "common.weekday.wednesday": "Wednesday",
  "common.weekday.thursday": "Thursday",
  "common.weekday.friday": "Friday",
  "common.weekday.saturday": "Saturday",

  /**
   * Words that belong to no single screen.
   *
   * `common.statusLabel` is the word "Status" as a heading, which is a
   * different question from `common.status.*` — those name the values it can
   * hold.
   */
  "common.save": "Save",
  "common.saving": "Saving\u2026",
  "common.cancel": "Cancel",
  "common.edit": "Edit",
  "common.statusLabel": "Status",

  /**
   * What a worker is, as a type.
   *
   * **Two vocabularies for the same two values, and both are correct.** A
   * worker already hired reports what it *is* — `Prompt`, `Website`. Somebody
   * choosing one is deciding what they want *done*, which is why the hire form
   * asks it as "Run a prompt" and "Watch a page". Collapsing them into one
   * label would make one of the two screens read as jargon.
   */
  "worker.kind.prompt": "Prompt",
  "worker.kind.website": "Website",
  "worker.kind.promptOption": "Run a prompt",
  "worker.kind.promptOptionDescription":
    "Sends your instructions to the AI on a schedule.",
  "worker.kind.websiteOption": "Watch a page",
  "worker.kind.websiteOptionDescription":
    "Checks a page and only involves the AI when it changes.",

  /**
   * A cadence as a menu option, which is not how a schedule reads in a
   * sentence — `schedule.*` carries that. `manual` has no entry of its own:
   * `worker.manual` already says it in both places.
   */
  "worker.frequency.daily": "Daily",
  "worker.frequency.weekly": "Weekly",
  "worker.frequency.monthly": "Monthly",

  /** What choosing a status means, shown under the select. */
  "worker.status.draftDescription":
    "Draft workers are not scheduled. Set Status to Active to run automatically.",
  "worker.status.activeDescription":
    "Runs automatically according to its schedule.",
  "worker.status.pausedDescription":
    "Scheduled runs are paused. Manual runs still work.",

  /**
   * The prompt column, under the two names it goes by.
   *
   * A prompt worker's prompt is the whole job. A website worker's runs only
   * once a change has been found, which is why the form asks for it as a
   * condition and both read-only screens call it what it is.
   */
  "worker.prompt": "Prompt",
  "worker.changeInstructions": "Change instructions",

  "worker.field.name": "Name",
  "worker.field.namePlaceholder": "Daily Website Update",
  "worker.field.description": "Description",
  "worker.field.descriptionPlaceholder": "What does this worker do?",
  "worker.field.websiteUrl": "Website address",
  "worker.field.promptPlaceholder": "Instructions sent to the AI on every run.",
  "worker.field.changePrompt": "When the page changes",
  "worker.field.changePromptPlaceholder":
    "What should the AI do when this page changes?",
  "worker.field.frequency": "Frequency",
  /**
   * Two selects, one English word, two Japanese ones. A weekly worker picks a
   * day of the week and a monthly one picks a date, and no language has to
   * pretend those are the same noun.
   */
  "worker.field.weekday": "Day",
  "worker.field.sameWeekday": "Same day it was saved",
  "worker.field.monthDay": "Day",
  "worker.field.sameMonthDay": "Same day it was saved",
  /** A date as an option: "3rd" in English, and a plain number elsewhere. */
  "worker.field.monthDayOption": "{ordinal}",
  "worker.field.monthDayNote":
    "Days past the end of a month run on the last day instead.",
  /**
   * The one setting on this form that reaches outside AutoOps.
   *
   * **What it says depends on the kind, because what it does depends on the
   * kind.** A website worker emails when the page it watches moves — not when
   * it is checked, which is most of the time — and a prompt worker emails when
   * its run finishes. One sentence covering both would have to be vague about
   * the half that matters.
   *
   * The failure line is shared, because failure means the same thing for
   * either. It does not mention the one failure that is not notified — a fetch
   * AutoOps declined to make because it had asked that site a moment ago — as
   * that is a decision of ours about our own politeness rather than anything
   * the owner set or can act on.
   */
  "worker.field.emailNotifications": "Email notifications",
  "worker.field.emailNotificationsWebsite":
    "Email me when this page changes.",
  "worker.field.emailNotificationsPrompt":
    "Email me when this worker finishes.",
  "worker.field.emailNotificationsFailure":
    "You will also be notified if the run fails.",
  "worker.field.runAt": "Run at",
  "worker.field.timezoneNote":
    "Times use your account timezone: {timezone}. Leave empty to run at whatever time the worker was saved.",
  /**
   * Where the zone above is changed.
   *
   * **Shown beside the zone rather than instead of it.** The sentence before it
   * already names the zone the account is on; what was missing is that it is a
   * setting at all, and where. A new account is on UTC because that is the
   * column's default — **this does not say the zone is unset**, which is
   * something the database cannot distinguish from somebody choosing UTC on
   * purpose.
   *
   * It appears only where the note does, which is only on a worker that runs on
   * a cadence. A manual worker has no time of day to interpret.
   */
  "worker.field.timezoneSettingsLink": "Change it in Settings",

  "worker.create.description":
    "Define the worker once. Koqentra runs it on your schedule.",
  "worker.create.draftHeading": "What would you like Koqentra to handle?",
  "worker.create.draftPlaceholder":
    "Check this page every day and summarise anything important that changed.",
  "worker.create.createDraft": "Create draft",
  "worker.create.drafting": "Drafting\u2026",
  /**
   * What a draft came back as, in one line.
   *
   * **The address and the cadence are the draft's, not the dictionary's.**
   * `{url}` is what somebody wrote in their request, and `{cadence}` for
   * anything but a manual worker is the stored frequency shown as it is
   * stored — the same string this card showed before it was translated.
   */
  "worker.create.draftWatches": "Watches {url}",
  "worker.create.draftSendsPrompt": "Sends its instructions to the AI",
  "worker.create.draftManual": "runs when you ask",
  "worker.create.draftSummary": "{what} \u00b7 {cadence}",
  "worker.create.applyToForm": "Apply to form",
  "worker.create.kindHeading": "What should this worker do?",
  /**
   * What the first successful check does, said before anybody waits for it.
   *
   * **The run it describes is a success, and reads like nothing happened.** A
   * first check has no earlier state to compare against, so it records the page
   * and stops: no model is asked, and no email goes out. Somebody who was
   * expecting a summary reads that as a broken worker — it came up in the
   * production end-to-end check — and the fix is to say so beforehand rather
   * than to start sending mail about a change nobody has seen yet.
   *
   * **No internal vocabulary.** Not "baseline", not "snapshot", not "hash":
   * what the reader needs is that the first run remembers the page, that it is
   * quiet on purpose, and that comparison starts from the next one.
   */
  "worker.create.websiteFirstRunNote":
    "The first check records the page as it is now and does not notify you — there is nothing to compare it against yet. Every check after that is compared with what was recorded, and you hear about it when something differs.",

  "worker.create.templatesHeading": "Choose a Template",
  "worker.create.templatesHelp":
    "Start from a template, or fill in the form below yourself.",

  /**
   * The two things a template can be, as headings over the list.
   *
   * **Named by what the reader gets, not by what the column holds.** `website`
   * and `prompt` are the stored kinds and the words the kind selector uses for
   * choosing one; these say what having one of each is *for*, which is the
   * question somebody scanning a list of examples is asking.
   */
  "template.group.website": "Have a page watched for you",
  "template.group.prompt": "Have AI do a job regularly",

  /**
   * The examples themselves.
   *
   * **All three parts of a template are translated, including the two that
   * become the worker.** The name is copied into the Name field and the prompt
   * into the instructions, so both end up as the account's own material — but
   * they arrive from AutoOps rather than from the account, and an example
   * offered in a language its reader does not use is not an example. What
   * stays untranslated is everything written *after* a template is applied.
   *
   * **A prompt holds `{{today}}` and `{{now}}` as literal text.** `t()` only
   * substitutes when it is given values, and nothing asks for these with any —
   * the doubled braces are for `lib/prompt.ts` to resolve at run time.
   *
   * **Every website example says AutoOps checks one page it was given.** None
   * of them may suggest searching, collecting or following anything else:
   * a watcher fetches the address it holds and compares it with what it saw
   * last time, and a template that implied more would be describing a product
   * that does not exist.
   *
   * **Every prompt example works only from what is written into it.** There is
   * no inbox, no calendar, no file and no search behind any of them, so each
   * one carries the place where its material goes.
   */
  "template.municipalNotices.name": "Watch a local government page",
  "template.municipalNotices.description":
    "Checks a local government page regularly. When an application, an event or a procedure changes, AI sums up what is different.",
  "template.municipalNotices.prompt": `Sum up what changed on this page, briefly and in plain words.

Pay attention to:
- applications opening or closing
- dates, times and places
- who it is for
- deadlines and how to apply
- documents added, replaced or removed

Leave out anything that did not change. Do not fill in what the page does not say.`,

  "template.productPage.name": "Watch a product page",
  "template.productPage.description":
    "Checks a product page regularly. When the price or what is being sold changes, AI sums up what is different.",
  "template.productPage.prompt": `Sum up what changed on this product page, briefly and in plain words.

Pay attention to:
- the price, and by how much it moved
- availability
- the specification or what is included
- campaigns, discounts and their end dates
- delivery, warranty and other conditions of sale

Leave out anything that did not change. Do not fill in what the page does not say.`,

  "template.careersPage.name": "Watch a company's careers page",
  "template.careersPage.description":
    "Checks a careers page regularly. When a job is added or a posting changes, AI sums up the role, the location and the conditions.",
  "template.careersPage.prompt": `Sum up what changed on this careers page, briefly and in plain words.

Pay attention to:
- postings added or taken down
- the role and the team
- the location, and whether it can be done remotely
- employment type, pay and requirements
- when applications open and close

Leave out anything that did not change. Do not fill in what the page does not say.`,

  "template.newsPage.name": "Watch a news page",
  "template.newsPage.description":
    "Checks the news page you give it regularly. When something is added or rewritten, AI sums up what is different.",
  "template.newsPage.prompt": `Sum up what changed on this page, briefly and in plain words.

Pay attention to:
- items that were added, and what each one says
- items that were removed
- items still there whose wording or date changed

List the new items first. Leave out anything that did not change, and do not fill in what the page does not say.`,

  "template.grantInfo.name": "Watch a grants page",
  "template.grantInfo.description":
    "Checks a grant or subsidy page regularly. When a round opens or the terms change, AI sums up who it is for, the deadline and what moved.",
  "template.grantInfo.prompt": `Sum up what changed on this page, briefly and in plain words.

Pay attention to:
- rounds opening or closing
- who is eligible
- what the money may be spent on
- how much is available
- the application deadline and the documents required

Leave out anything that did not change. Do not fill in what the page does not say.`,

  "template.dailyWorkPlan.name": "Plan the day's work",
  "template.dailyWorkPlan.description":
    "From what you write in, AI puts the day's checks and tasks in order of what matters most.",
  "template.dailyWorkPlan.prompt": `Today is {{today}}.

Using only what is written below, put today's checks and tasks in order of what matters most. Give each one a single line saying why it comes where it does, and finish with anything that has to be decided by somebody else.

Do not add anything that is not written below. If something is unclear, say so rather than filling it in.

--- TODAY'S PLANS, REQUESTS AND CONCERNS ---
(write yours here)`,

  "template.ideaGenerator.name": "Think up ideas regularly",
  "template.ideaGenerator.description":
    "On the theme you write in, AI comes up with new ideas and improvements each time it runs.",
  "template.ideaGenerator.prompt": `Come up with five ideas or improvements for the theme below. Give each one a line on what it is for and a line on the first step it would take.

Make them genuinely different from one another rather than five wordings of the same thought.

Work only from what is written below, and do not state anything as fact that is not there.

--- THEME ---
(write yours here)`,

  "template.recurringReport.name": "Write a recurring report",
  "template.recurringReport.description":
    "From the material you write in, AI produces a report in the same shape every time.",
  "template.recurringReport.prompt": `Generated at {{now}}.

Using only the material below, write a report in these four sections:

1. Summary, in three lines
2. What the material shows
3. What is worth watching
4. What to do next

Write nothing that is not in the material. Where a section has nothing to draw on, write "no information" rather than filling it in.

--- MATERIAL ---
(write yours here)`,

  /**
   * Why drafting produced nothing.
   *
   * **All eight are AutoOps speaking, which is what lets them be translated.**
   * What a generator returns for `unsupported` or `needs_input` is a sentence
   * the model wrote about a particular request; it goes to the screen exactly
   * as it arrived and has no key here.
   */
  "worker.draft.notConfigured":
    "Drafting is unavailable because Koqentra has no AI configured.",
  "worker.draft.empty": "Describe what you would like Koqentra to handle.",
  "worker.draft.tooLong": "Keep the description under {limit} characters.",
  "worker.draft.timeout": "Drafting took too long. Try again.",
  "worker.draft.unavailable": "The AI service could not be reached. Try again.",
  "worker.draft.unreadable":
    "Koqentra could not read the answer. Try describing the work again.",
  /**
   * The account has asked for as many drafts in an hour as the allowance
   * holds. **It says when to come back rather than how much is left**: a count
   * would invite counting, and the useful thing is that waiting works.
   */
  "worker.draft.limitReached": "AI draft limit reached. Try again later.",
  /**
   * Drafting did not work, and what stopped it was AutoOps rather than the
   * model — today, the allowance it keeps in its own database.
   *
   * **It names no cause, and that is the accurate thing to do rather than the
   * vague one.** `unavailable` says the AI service could not be reached, which
   * would be a false statement about a database that would not answer; the
   * database is not the reader's business either. What is true and useful is
   * that drafting cannot happen at the moment and that trying later is worth
   * it.
   */
  "worker.draft.failed": "Drafting is unavailable right now. Try again.",

  /**
   * What comes back from asking Koqentra to read a piece of writing.
   *
   * **The vocabulary is the Creator one, not the worker one.** Nothing here
   * says "draft", "run" or "worker": those already mean specific things on the
   * other side of the product — a proposal for a worker's settings, one
   * execution of one — and a third meaning would make every sentence about
   * either of them ambiguous. What this side produces is a *post*.
   *
   * **None of these repeats what went wrong underneath.** A provider's message
   * names services and status codes, a driver's names tables; neither is
   * something the person who pasted an article can act on, and both are the
   * kind of detail that should not travel outward. What each says is what the
   * reader can do next.
   */
  "creator.analysis.notConfigured":
    "Koqentra is not set up to read your writing yet.",
  "creator.analysis.empty": "Paste the writing you would like read.",
  "creator.analysis.tooLong": "That piece is too long to read in one go.",
  /**
   * The allowance is spent. **An ordinary answer, not a failure** — and it says
   * so without naming a number, because a count invites arithmetic and the
   * useful fact is that waiting works.
   */
  "creator.analysis.limitReached":
    "You have reached this hour's limit. Try again later.",
  "creator.analysis.timeout": "Reading took too long. Try again.",
  "creator.analysis.unavailable":
    "The AI service could not be reached. Try again.",
  /** An answer arrived and could not be used. Retrying is genuinely worth it. */
  "creator.analysis.unreadable":
    "The AI's answer could not be read. Try again.",
  /**
   * Something on Koqentra's own side stopped it — today, its database.
   *
   * **It names no cause on purpose.** `unavailable` would be a false statement
   * about a database that would not answer, and the database is not the
   * reader's business either. What is true and useful is that it cannot happen
   * at the moment and that trying later is worth it.
   */
  "creator.analysis.failed": "This is unavailable right now. Try again.",
  "creator.analysis.done": "Your writing has been read.",

  /** What comes back from agreeing, rewriting, or disagreeing with a decision. */
  "creator.feedback.saved": "Thanks — that has been noted.",
  /**
   * Answers are kept as they were given. **Not an error and not an overwrite**:
   * the record of what somebody decided at a moment does not later become a
   * record of something else.
   */
  "creator.feedback.alreadyRecorded": "You have already answered this one.",
  "creator.feedback.invalid": "That answer does not fit this suggestion.",
  "creator.feedback.failed": "That could not be saved right now. Try again.",

  "worker.detail.noDescription": "No description.",
  "worker.detail.workerType": "Worker type",
  /** A kind stored by a version this one cannot read. It says so; it does not guess. */
  "worker.detail.unrecognised": "Unrecognised",
  "worker.detail.lastRun": "Last Run",
  "worker.detail.createdAt": "Created At",
  "worker.detail.updatedAt": "Updated At",
  "worker.detail.watchedPage": "Watched page",
  /**
   * The way from a worker to one of its executions.
   *
   * Named for what it lists rather than for what it is for — the reason a run
   * failed is on the run's own page, and this is how somebody gets there once
   * the account's activity list has moved on past it.
   */
  "worker.detail.runHistory": "Run History",
  "worker.detail.runHistoryEmpty": "This worker has not run yet.",
  "worker.detail.dangerZone": "Danger zone",
  "worker.detail.deleteWarning":
    "Deleting this worker also removes its activity history. This cannot be undone.",

  "worker.delete.button": "Delete",
  "worker.delete.deleting": "Deleting\u2026",
  /** The name is the owner's, and is placed rather than glued to either end. */
  "worker.delete.confirmTitle": "Delete \u201c{name}\u201d?",
  "worker.delete.confirmBody":
    "This also removes its activity history. This cannot be undone.",

  "worker.edit.title": "Edit Worker",
  "worker.edit.description": "Changes apply to the next run.",
  /**
   * What moving a watcher costs, said before it is moved.
   *
   * **Every clause is held to what execution actually does**, in whichever
   * language it is read:
   *
   * - *the next successful check*, not the next one. A check that cannot fetch
   *   the page writes no baseline and leaves the worker where it was.
   * - *instead of treating the new page as a detected change*, rather than
   *   "reports no changes". Establishing a first baseline is its own outcome,
   *   and naming it is what rules out the whole of a new page arriving as
   *   though it had just changed.
   * - *past runs are kept*, because what is thrown away is the stored
   *   comparison point and nothing else. Saving the form fetches nothing and
   *   involves no model.
   *
   * A translation that weakens any of the three describes a mechanism nobody
   * can see, which is the only reason this sentence exists.
   */
  "worker.edit.baselineReset":
    "Changing the address resets the comparison baseline. On the next " +
    "successful check, Koqentra establishes a new baseline instead of treating " +
    "the new page as a detected change. Past runs are kept.",

  "run.detail.title": "Execution",
  "run.detail.back": "Back to Dashboard",
  /** The product's own noun, and the one word here that is the same in both. */
  "run.detail.worker": "Worker",
  "run.detail.executionTime": "Execution Time",
  "run.detail.startedAt": "Started At",
  "run.detail.finishedAt": "Finished At",
  "run.detail.renderedPrompt": "Rendered Prompt",
  "run.detail.output": "Output",
  "run.detail.error": "Error",

  /**
   * What a form says about what was typed into it.
   *
   * **The rules are not here — only the words for them.** Which fields are
   * required, and when, is `lib/worker-input.ts`'s answer and is the same in
   * every language; a translation decides how the refusal reads.
   *
   * `{label}` is the field's own name, taken from the labels the form already
   * shows, so a Japanese message cannot name an English field. `{limit}` is
   * grouped the way it always was — a formatting question rather than a
   * wording one.
   */
  "worker.validation.nameRequired": "Name is required.",
  "worker.validation.promptRequiredForScheduled":
    "Prompt is required for scheduled active workers.",
  "worker.validation.tooLong": "{label} must be {limit} characters or fewer.",
  "worker.validation.websiteUrlRequired": "Website address is required.",
  "worker.validation.changePromptRequired":
    "Tell the worker what to do when the page changes.",
  /**
   * **Syntax only, and the example is not translated.** Nothing has been
   * resolved or requested when this is said; a page that passes here can still
   * be refused on every run. A URL is not language.
   */
  "worker.validation.websiteUrlInvalid":
    "Enter a full website address, like https://example.com/news.",
  /** One line for the toast when several fields are wrong at once. */
  "worker.validation.summary": "{count} fields need attention.",

  /**
   * What saving, deleting or running a worker says back.
   *
   * **The name inside is the owner's**, placed into the sentence rather than
   * glued to one end of it: the two languages do not put it in the same spot,
   * and neither of them translates it.
   */
  /**
   * The account has as many workers as it may keep.
   *
   * **It says what to do rather than only what happened.** Nothing here can be
   * waited out — unlike a rate limit, capacity comes back only when the owner
   * frees some — so the sentence names the action that does it.
   */
  "worker.validation.totalLimitReached":
    "You already have the maximum number of Workers ({limit}). Delete one to add another.",
  /** The account has as many active workers as it may run at once. */
  "worker.validation.activeLimitReached":
    "You can have {limit} active Workers at a time. Pause one to activate another.",

  "worker.action.kindRequired":
    "Choose whether this worker runs a prompt or watches a page.",
  /** Missing and someone else's are deliberately the same answer. */
  "worker.action.notFound": "Worker not found.",
  "worker.action.createFailed": "Could not create the worker.",
  "worker.action.created": "Worker \"{name}\" created.",
  "worker.action.noWatchedPage":
    "This worker has no watched page, so it cannot be saved.",
  "worker.action.saveFailed": "Could not save the worker.",
  "worker.action.saved": "Worker \"{name}\" saved.",
  "worker.action.deleteFailed": "Could not delete the worker.",
  "worker.action.deleted": "Worker deleted.",

  /**
   * What a hand-started run says back.
   *
   * **Busy is not broken.** "Already running" is not a failure — nothing was
   * attempted — and the sentence has to lead somewhere different from the one
   * that means something went wrong.
   *
   * **None of these is what the run produced.** Output and the reason a run
   * failed are stored on the execution and shown there, in the words they
   * arrived in.
   */
  /**
   * The two sentences a website worker's own runs record when there was
   * nothing for a model to say.
   *
   * **Stored in English and translated when shown.** They sit in
   * `RunHistory.output` beside what models write, which is the account's
   * material and is never touched — see `lib/run-display.ts` for the two
   * conditions that keep the two apart.
   *
   * **`websiteBaseline` no longer repeats what is stored, and that is the
   * point.** The stored sentence — "Website baseline is not established yet." —
   * is written from the moment before the run: it names the state the check
   * found. Read afterwards, on the page of a run that succeeded, it says
   * nothing happened. It is the same successful run the Japanese calls
   * 「サイトの初回状態を記録しました。」, and an English reader was the only
   * one being told their worker had not done anything.
   *
   * **The stored value is untouched.** Changing it would break the exact match
   * in `lib/run-display.ts` and strand every row already written; translating
   * at display time is precisely what lets an old row read correctly today.
   * `websiteUnchanged` still matches its stored wording, because that one was
   * never misleading.
   */
  "run.system.websiteBaseline": "The website's initial state was recorded.",
  "run.system.websiteUnchanged": "Website content has not changed.",

  /**
   * What an email about a finished run says, and the whole of what is
   * translated in one.
   *
   * **The labels are AutoOps talking; everything they introduce is not.**
   * `{name}` is the worker's name as it was typed, and the body carries a
   * model's summary or a prompt worker's output exactly as it was stored —
   * setting the interface to Japanese does not translate somebody's work, in an
   * inbox any more than on a screen.
   *
   * **The failure line says nothing about the failure**, deliberately. The
   * stored reason is a diagnostic in whatever wording it arrived with, and the
   * link goes to the page that shows it.
   */
  "notify.email.changedSubject": "[Koqentra] \"{name}\" detected a change",
  "notify.email.completedSubject": "[Koqentra] \"{name}\" completed",
  "notify.email.failedSubject": "[Koqentra] \"{name}\" failed",
  "notify.email.worker": "Worker: {name}",
  "notify.email.detectedAt": "Detected at: {time}",
  "notify.email.executedAt": "Executed at: {time}",
  "notify.email.failedBody": "The run failed. Open Koqentra for details.",
  "notify.email.truncated": "The rest is available in Koqentra.",
  "notify.email.viewRun": "View this run in Koqentra:",

  "run.action.noWorkerSelected": "No worker selected.",
  "run.action.alreadyRunning": "\"{name}\" is already running.",
  /**
   * The account already has a hand-started run going — a different worker's,
   * or this one would have said `alreadyRunning` instead.
   *
   * **Two sentences rather than one**, because they lead somewhere different:
   * that one says the worker you pressed is busy, and this one says you are.
   * Naming no worker is the point — the run in the way may be any of them.
   */
  "run.action.userBusy":
    "Another run of yours is still in progress. Wait for it to finish.",
  /**
   * Nothing was started, and what stopped it was AutoOps rather than the
   * worker — today, the guard it keeps in its own database.
   *
   * **It does not say the run failed**, which `run.action.failed` says and
   * which would be untrue: nothing ran, nothing was billed, and there is no
   * result page to look at.
   */
  /**
   * The account has started as many runs by hand as it may in an hour.
   *
   * **Not `userBusy`.** That one means a run of theirs is happening right now
   * and will finish; this one means waiting is the only thing that helps, and
   * for longer. The two lead somewhere different, so they are two sentences.
   */
  "run.action.rateLimited":
    "Manual run limit reached. Try again later.",
  "run.action.couldNotStart":
    "\"{name}\" could not be started. Try again in a moment.",
  "run.action.outcomeNotRecorded":
    "\"{name}\" started, but its outcome could not be recorded.",
  "run.action.failed": "\"{name}\" failed to run.",
  "run.action.succeeded": "\"{name}\" ran successfully.",

  "settings.title": "Settings",
  "settings.description":
    "How Koqentra reads and schedules times for your account.",
  "settings.timezone.title": "Timezone",
  /**
   * What saving a zone does, and deliberately not what it does not.
   *
   * Saving writes one column, and nothing reads or rewrites a worker's pending
   * slot on the way — so the run already scheduled stays exactly where it was.
   *
   * **What happens to the runs after that one is not described here, in any
   * language.** It is not one rule: a worker with a Run at time has that time
   * re-read in the new zone when its schedule next advances, while a worker
   * with Run at left empty keeps the moment it already had. Any sentence short
   * enough for this page would be wrong about one of the two.
   */
  "settings.timezone.note":
    "Timestamps are shown in this zone, and a worker set to run at 09:00 " +
    "runs at 09:00 here. Changing the timezone does not change any " +
    "worker\u2019s already-scheduled next run.",
  "settings.timezone.invalid": "Select a timezone from the list.",
  "settings.timezone.failed": "Could not save your timezone.",
  "settings.timezone.saved": "Timezone saved.",

  "settings.language.title": "Language",
  "settings.language.description":
    "The language Koqentra uses for its own screens. Your workers and what they produce are unaffected.",
  "settings.language.label": "Language",
  "settings.language.english": "English",
  "settings.language.japanese": "Japanese",
  "settings.language.saved": "Language saved.",
  "settings.language.invalid": "Select a language from the list.",
  "settings.language.failed": "Could not save your language.",

  /**
   * How somebody reaches a person.
   *
   * **Settings is where it sits because that is the one page inside the
   * dashboard that is about the account rather than about a worker**, and
   * because no page behind sign-in has a footer to put it in. Somebody who is
   * stuck goes looking for settings; somebody who is not never needs this.
   *
   * **The whole section is absent when no address is configured** — see
   * `lib/support.ts`. These words are never shown next to a link that goes
   * nowhere.
   *
   * `settings.support.subject` is the subject line the message opens with. It
   * is short on purpose: whoever reads the mailbox needs to know which product
   * it is about, and the person writing needs the room.
   */
  "settings.support.title": "Support",
  "settings.support.description":
    "Koqentra is in Closed Beta. If something is not working the way you expected, or you are not sure whether it is working at all, write to us — that is what the beta is for.",
  "settings.support.action": "Email support",
  "settings.support.subject": "Koqentra support",
} as const;

/**
 * Every key a translation may hold, and every key it must.
 *
 * Derived rather than declared, so the list cannot drift from the English copy
 * it describes.
 */
export type TranslationKey = keyof typeof en;
