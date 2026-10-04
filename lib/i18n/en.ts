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
  "nav.creator": "Creator",
  "nav.settings": "Settings",
  /**
   * The Worker side of the product, named for what it holds.
   *
   * **Its own key rather than a rewording of `nav.dashboard`.** That one means
   * "the dashboard", and the route is still `/dashboard`; this one is a label
   * saying which part of Koqentra the link goes to. Somebody arriving at a bar
   * that says "Dashboard" reasonably expects the whole product, and since
   * Creator opens first that expectation is now wrong.
   */
  "nav.workers": "Workers",
  /**
   * The plans page, named for what it holds rather than for buying.
   *
   * Everybody may read it — what a plan allows and what a smaller allowance
   * would mean is worth knowing before anybody is asked for money — so the label
   * says Plans rather than Upgrade, which would be a link that lied to whoever
   * cannot buy yet.
   */
  "nav.plans": "Plans",
  "nav.signOut": "Sign out",
  /** Stands in for a name the provider did not give us. */
  "nav.signedIn": "Signed in",

  /**
   * The screen signing in lands on.
   *
   * **It greets and it does not claim.** Every number on it is a reading of
   * something with a screen of its own, so the words say what they are rather
   * than summarising a state the page is not the authority on.
   *
   * **"AI processing", never "AI processing this month".** The counters behind it cover the
   * account's current usage period, which begins when the account first used
   * something in it — so a monthly total is exactly what the number is not for
   * an account whose period started late. `currentUsagePeriod` says what it is
   * measured over instead of guessing at a calendar.
   */
  "dashboard.home.title": "Home",
  "dashboard.home.welcome": "Welcome back",
  "dashboard.home.subtitle":
    "Start or check your Koqentra work from here.",
  "dashboard.home.openCreator": "Open Creator",
  "dashboard.home.createWorker": "Create a Worker",
  "dashboard.home.overview": "Overview",
  "dashboard.home.activeWorkers": "Workers active at once",
  "dashboard.home.aiRuns": "AI processing",
  "dashboard.home.currentUsagePeriod": "Current usage period",
  "dashboard.home.currentPlan": "Current plan",
  /**
   * **Said for an ended subscription as well as for none at all.** A plan that
   * entitles nothing is not a plan somebody is on, and naming it would be the
   * defect the plans page was fixed for.
   */
  "dashboard.home.noPlan": "No plan",
  "dashboard.home.recentActivity": "Recent activity",
  "dashboard.home.noRuns": "No runs yet.",
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
  /**
   * What a discovery worker is called where a worker's kind is reported.
   *
   * **Named for what it produces rather than for how it works.** "Discovery" is
   * what the code calls it because the domain is provider-neutral; what the
   * owner gets is a short list of things somebody might want to watch, and
   * "Recommendations" is the word for that in a row that answers "what is
   * this".
   *
   * **Not the same words the hire form uses**, which is the pattern the other
   * two already follow: somebody choosing is deciding what they want done
   * (`discoveryOption`, "Find recommendations"), and a worker that exists
   * reports what it is.
   */
  "worker.kind.discovery": "Recommendations",
  "worker.kind.promptOption": "Run a prompt",
  "worker.kind.promptOptionDescription":
    "Sends your instructions to the AI on a schedule.",
  "worker.kind.websiteOption": "Watch a page",
  "worker.kind.websiteOptionDescription":
    "Checks a page and only involves the AI when it changes.",
  /**
   * The third option, named for what somebody wants rather than for where it
   * looks.
   *
   * **"YouTube" is not in it, deliberately.** YouTube is the provider this
   * version asks; what the person is deciding is that they want things found
   * for them. Naming the provider here would make a second one a rename of the
   * feature.
   */
  "worker.kind.discoveryOption": "Find recommendations",
  "worker.kind.discoveryOptionDescription":
    "Looks for new things on a topic and recommends a few, with a reason for each.",

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
  "worker.prompt": "What to ask the AI",
  "worker.changeInstructions": "Change instructions",

  "worker.field.name": "Name",
  "worker.field.namePlaceholder": "Daily Website Update",
  "worker.field.description": "Description",
  "worker.field.descriptionPlaceholder": "What does this worker do?",
  "worker.field.websiteUrl": "Website address",
  /** Named in a length message, which is the only place it is read so far. */
  "worker.field.discoveryQuery": "What to look for",
  "worker.field.discoveryQueryPlaceholder": "hedgehog care",
  "worker.field.discoveryMaxResults": "How many to recommend",
  /**
   * Said before anybody counts what came back.
   *
   * **Nothing pads the list out.** A run recommends what met the conditions and
   * stops, so asking for five is a ceiling rather than a promise — and a
   * recommendation nobody stands behind is worse than a short list.
   */
  "worker.field.discoveryMaxResultsHelp":
    "If fewer items match your criteria, Koqentra may return fewer than the requested number.",
  /**
   * What Koqentra actually knows about what it has already offered.
   *
   * **"Previously recommended" and nothing wider.** Koqentra does not know what
   * has been watched, what is new to the world, or what anybody has already
   * seen elsewhere — it knows which items it has itself recommended for this
   * worker. Saying more would be claiming a fact nothing records.
   */
  "worker.field.discoveryDedupNote":
    "Previously recommended items are excluded.",
  /**
   * The rule the code enforces after the model has chosen.
   *
   * **A note rather than part of the instruction.** It is applied in code, so
   * putting it in the editable box would let somebody delete a rule that would
   * still be applied — and leave the box describing something it does not
   * decide.
   */
  "worker.field.discoveryDiversityNote":
    "At most one recommendation is selected from the same creator.",
  "worker.field.discoveryInstruction": "How to choose",
  /**
   * What the model is working from, said plainly.
   *
   * **Three fields and no more.** The model sees a title, who published it and
   * when; it has not watched anything, read a description, or seen how anything
   * was received. An instruction written as though it had would be asking for
   * an answer nothing can support.
   */
  "worker.field.discoveryInstructionHelp":
    "The AI sees each item's title, who published it and when — nothing else. It has not watched or read anything.",
  "worker.field.promptPlaceholder":
    "Describe what you want this Worker to do.",
  /**
   * Shown under the prompt box of a prompt worker, and only that one.
   *
   * **Two sentences because two people arrive at the same box.** One came
   * from a template and is looking for where their own part goes; the
   * other started from nothing and is looking for permission to write
   * plainly. Neither is helped by being told what the field is called.
   *
   * A website worker gets no such note: its box holds finished
   * instructions rather than an example waiting to be completed.
   */
  "worker.field.promptHelp":
    "If you used a template, add your own details at the end of this field. If you are starting from scratch, write what you want the AI to do.",
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
  "worker.field.emailOneWorker":
    "On this plan, email notifications are available for one worker.",
  "worker.field.emailSwitchConfirm":
    "Move email notifications to this worker (the current one will stop sending them)",
  "worker.validation.emailSwitchRequired":
    "Email notifications are available for one worker on this plan, and \"{name}\" currently sends them. To move them to this worker, tick the confirmation below and save.",
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
  /**
   * What the screen says about itself in a browser tab, not on the screen.
   *
   * **Its own string rather than the description above it.** The two answer
   * different questions: one introduces the screen to somebody already looking
   * at it, the other has to say what the screen is to somebody reading a tab
   * strip or a search result. Reusing the longer one would have reworded the
   * product to save a string.
   */
  "worker.create.metadataDescription": "Add a new AI worker to your team.",
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

  /**
   * Where Koqentra stops and the person starts.
   *
   * **Said on the form rather than discovered afterwards.** A worker that finds
   * things could reasonably be expected to do something with them — follow,
   * like, comment, subscribe, post. It does none of that and never will on this
   * path: it hands over a short list and a reason for each, and every action
   * after that is somebody's own.
   */
  "worker.create.discoveryHumanNote":
    "Koqentra finds candidates and recommends a few. Watching, following, commenting and everything else stays with you.",

  "worker.create.templatesHeading": "Choose a Template",
  "worker.create.templatesHelp":
    "Choose a template to fill in an example below. Add your own details where the example leaves space.",

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
  "template.group.discovery": "Have things found for you",
  /**
   * The one discovery example, named for the habit rather than the source.
   *
   * **No provider in the name.** A second provider would otherwise make
   * renaming the example part of adding it.
   *
   * **It carries no search.** What to look for is the one thing only the
   * person choosing can know — the same reason a website template carries no
   * address.
   */
  "template.recommendationFinder.name": "Find daily recommendations",
  "template.recommendationFinder.description":
    "Looks for new things on a topic every day and recommends a few.",
  "template.recommendationFinder.prompt":
    "Prefer recent items and choose recommendations that are likely to be interesting.",

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
    "Write down today's plans, requests, or concerns, and the AI will organize what to do today.",
  "template.dailyWorkPlan.prompt": `Today is {{today}}.
Using the notes below, put today's tasks in priority order.
For each task, explain the reason for its priority in one line.
At the end, list anything that needs a decision from someone else.
Do not make up details that are not provided.

Today's plans, requests, or concerns:
`,

  "template.ideaGenerator.name": "Think up ideas regularly",
  "template.ideaGenerator.description":
    "Give the AI one topic, and it will come up with 5 different ideas.",
  "template.ideaGenerator.prompt": `Come up with 5 new ideas about the topic below.
For each one, add one line explaining the idea and one first step.
Make the 5 ideas meaningfully different.
Do not make up details that are not provided.

Topic for ideas:
`,

  "template.recurringReport.name": "Write a recurring report",
  "template.recurringReport.description":
    "Add the information you want to report on, and the AI will organize it into the same format each time.",
  "template.recurringReport.prompt": `Created: {{now}}
Using the notes below, make a report with these 4 sections:

1. Summary (3 lines)
2. What we learned
3. What needs attention
4. Next steps

Do not make up details that are not provided.

Notes for the report:
`,

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

  /**
   * Why a page could not be used, in the six situations a reader can act on.
   *
   * **None of them quotes the page or the address.** The fetch boundary names
   * seventeen kinds and can carry a host, a status or a charset; those stay in
   * the log. What these say is what to do next.
   *
   * `urlUnreadable` names the common case in the sentence — a PDF, or a page
   * whose text arrives from JavaScript — because "could not be read" on its own
   * sends somebody looking for a mistake they did not make.
   */
  "creator.analysis.urlInvalid":
    "Check the address. Koqentra reads ordinary http and https pages on their usual port.",
  "creator.analysis.urlBlocked": "That address cannot be fetched.",
  "creator.analysis.urlUnavailable":
    "The page could not be fetched. Try again in a moment.",
  "creator.analysis.urlUnreadable":
    "That page could not be read as an HTML document. PDFs and pages that build their text in the browser are not supported — paste the text instead.",
  "creator.analysis.urlTooLarge":
    "That page is too large to read in one go. Paste the part you want read.",
  "creator.analysis.urlEmpty":
    "No readable text was found on that page. Paste the text instead.",

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

  /**
   * The Creator screens.
   *
   * **Two words are deliberately absent from every string below.** "Draft"
   * already means a proposal for a worker's settings, and "run" already means
   * one execution of a worker; using either for what happens here would make
   * every sentence about the other one ambiguous. What Koqentra produces on
   * this side is a **post text**, and what it does is **analyse**.
   */
  "creator.inbox.title": "Review Inbox",
  "creator.inbox.description":
    "What Koqentra suggested, waiting for you to agree, rewrite, or turn down.",
  /**
   * What the screen says about itself in a browser tab, not on the screen.
   *
   * **Its own string rather than the description above it.** The two answer
   * different questions: one introduces the screen to somebody already on it,
   * the other has to say what the screen is to somebody looking at a tab
   * strip or a search result, in a single line. Reusing the longer one would
   * have changed wording that was chosen for a different place.
   */
  "creator.inbox.metadataDescription":
    "What Koqentra suggested, waiting for your answer.",
  "creator.inbox.analyzeCta": "Analyze content",
  /** Nothing waiting is the ordinary state, not a failure. */
  "creator.inbox.emptyTitle": "Nothing to review",
  "creator.inbox.emptyBody":
    "Analyze a piece of writing and its suggestions for X, Reddit and long-form will arrive here.",
  "creator.inbox.untitled": "Untitled content",
  "creator.inbox.pending": "{count} waiting",

  /**
   * Which analysis a heading belongs to.
   *
   * **Absolute, never relative.** "3 minutes ago" is friendlier and useless
   * here: the reason a timestamp is on this screen at all is that two
   * submissions of the same piece are otherwise two identical headings, and
   * telling them apart is what the exact moment does.
   */
  "creator.inbox.analyzedAt": "Analyzed: {at}",
  "creator.inbox.historyCta": "History",

  /**
   * Where an analysis got its material.
   *
   * **Shown only where there was an address**, and it is the address the page
   * was actually read from — after redirects — because that is the page the
   * decisions are about. A pasted piece has no source to name.
   */
  "creator.source.page": "Source page",

  /**
   * What was already answered.
   *
   * **A record, and read-only.** Nothing on that screen changes an answer:
   * feedback is append-only, and a history offering to rewrite itself would
   * not be one. `creator.history.pendingNote` explains why a piece can be on
   * both screens at once — the two show different halves of the same analysis.
   */
  "creator.history.title": "Answer history",
  /**
   * **"Older answers", not "Load more".** Following this is a navigation to a
   * different page of the record, not an append to the list already on screen
   * — and somebody told the list would grow would be looking for entries that
   * are no longer there.
   */
  "creator.history.olderAnswers": "Older answers",
  "creator.history.backToLatest": "Back to latest",
  "creator.history.description":
    "The judgements you have already answered, newest analysis first.",
  "creator.history.metadataDescription":
    "The judgements you have already answered.",
  "creator.history.pendingNote":
    "An analysis with unanswered judgements also appears in the Review Inbox.",
  "creator.history.answeredCount": "{count} answered",
  "creator.history.answeredAt": "Answered: {at}",
  "creator.history.yourPostText": "Your post text",
  "creator.history.emptyTitle": "Nothing answered yet",
  "creator.history.emptyBody":
    "Answer something in the Review Inbox and it will be kept here.",

  "creator.channel.x": "X",
  "creator.channel.reddit": "Reddit",
  "creator.channel.longform": "Long-form",

  "creator.verdict.recommend": "Recommended",
  /** A decision in its own right — not an error, and not a failure to answer. */
  "creator.verdict.skip": "Skip",

  "creator.postText": "Post text",

  /** What the buttons say depends on what is being answered. */
  /**
   * Adopting a recommendation, which is a copy and an answer at once.
   *
   * **It says copy because copying is what Koqentra does.** Nothing is posted
   * anywhere, and a label promising otherwise would describe a product that
   * does not exist. `creator.feedback.copyFailed` is what a reader sees when
   * the clipboard refused — the answer was not sent either, so the decision is
   * still there to try again.
   */
  "creator.feedback.copyAndUse": "Copy and use",
  "creator.feedback.copyFailed":
    "Could not copy the post text. Please try again.",
  "creator.feedback.useAsIs": "Use as-is",
  "creator.feedback.editAndUse": "Edit & use",
  "creator.feedback.reject": "Reject",
  "creator.feedback.agreeWithSkip": "Agree with skip",
  "creator.feedback.wouldPost": "I would post this",
  "creator.feedback.save": "Save",
  "creator.feedback.cancel": "Cancel",
  "creator.feedback.editLabel": "Your version",
  "creator.feedback.sending": "Saving…",

  "creator.new.title": "Analyze content",
  "creator.new.metadataDescription":
    "Have Koqentra read a piece of writing and say where it belongs.",
  "creator.new.description":
    "Koqentra reads what you paste and says, for X, Reddit and long-form separately, whether it is worth posting there — and writes the post if it is. Deciding against a channel is a normal answer.",
  "creator.new.titleLabel": "Title",
  "creator.new.titleOptional": "Optional",
  "creator.new.bodyLabel": "Your writing",
  "creator.new.bodyPlaceholder": "Paste the piece you want read.",
  "creator.new.submit": "Analyze",
  "creator.new.submitting": "Analyzing…",
  /**
   * **Says what actually happens, and no more.** Past answers are read back as
   * context on the next analysis; nothing summarises them into a stored profile
   * of somebody, and claiming otherwise would describe a feature that does not
   * exist.
   */
  "creator.new.learningNote":
    "Your past approvals, edits, and rejections are used as context for future analyses.",
  "creator.new.privacyNote":
    "The content you submit is sent to Anthropic for analysis.",
  "creator.new.privacyLink": "Privacy",

  /**
   * Said to somebody who has stated no preferences at all.
   *
   * **Shown only when all three are empty**, because that is the one state
   * where "nothing has been said yet" is unambiguous. Somebody who filled in
   * one of them has told Koqentra what they wanted to tell it, and calling that
   * incomplete would be the product disagreeing with them.
   *
   * **It describes what the preferences are for, and stops there.** Koqentra
   * derives nothing about anybody — there is no memory of somebody being built
   * up — so this may not say it learns, remembers, or notices a taste.
   *
   * `creator.new.preferencesOptional` is the half that keeps the whole thing
   * non-blocking: the form below it works exactly as well with none of this
   * set, and saying so is what stops the callout reading as a gate.
   */
  "creator.new.preferencesPrompt":
    "Set who you want to reach, what you want to achieve, and how you want to sound so Koqentra can use that context when deciding where your content fits and how to write it.",
  "creator.new.preferencesAction": "Open Creator preferences",
  "creator.new.preferencesOptional": "You can analyze without setting this.",

  /**
   * Choosing between pasting and giving an address.
   *
   * **The help text says what is not supported**, because "read any URL" is
   * what a bare field promises and it is not true: pages behind a sign-in are
   * never fetched, and PDFs are refused.
   *
   * `urlPrivacyNote` is a different sentence from the paste one on purpose. A
   * URL adds something the paste path does not do — Koqentra's server makes a
   * request to somebody else's site — and a reader deserves to be told that
   * before they press the button rather than only in a policy page.
   */
  "creator.new.sourceText": "Text",
  "creator.new.sourceUrl": "URL",
  "creator.new.sourceLabel": "What would you like read?",
  "creator.new.urlLabel": "Page address",
  "creator.new.urlPlaceholder": "https://example.com/article",
  "creator.new.urlHelp":
    "Koqentra reads public HTML pages. Pages that need a sign-in, and PDFs, are not supported.",
  "creator.new.urlPrivacyNote":
    "Koqentra fetches this page from its own server, and sends the address and the text it reads to Anthropic for analysis.",

  /**
   * What the next analysis will be told, shown before it happens.
   *
   * **Stored facts, not conclusions.** Everything under this heading is either
   * something the person typed or something they did — nothing here is a claim
   * about what they *prefer*, because Koqentra does not derive one. Wording
   * like "we have learned that you like…" would describe a feature that does
   * not exist and would be read as one that does.
   */
  /**
   * **No product name in the heading.** The dictionary's rule is that a key
   * naming Koqentra in English names it in Japanese too, and the natural
   * Japanese for this sentence does not — so the English drops it rather than
   * the Japanese gaining an awkward one.
   */
  "creator.learning.title": "What will be considered",
  "creator.learning.description":
    "The preferences you have set, and how you answered recently.",
  "creator.learning.profileHeading": "Publishing preferences",

  /**
   * What Koqentra concluded from answers it no longer shows one by one.
   *
   * **Said as a derivation, never as a fact about somebody.** Koqentra does not
   * know what this person prefers; it has a summary a model wrote from answers
   * that scrolled out of the recent list, and that summary can be wrong. The
   * description says so, and says which evidence outranks it — that is the same
   * order the analyzer actually applies.
   *
   * **The count is what the summary was built from, not how many old answers
   * exist.** Catching up on a long history happens a batch at a time, so the
   * two can differ while it is in progress. Saying "based on {count}" is
   * accurate at every step; saying "all of them" would not be.
   */
  "creator.learning.memoryHeading": "Summary from older answers",
  "creator.learning.memoryNote":
    "This is an AI-generated summary of older answers that are no longer shown individually below. It may be imperfect. Your stated preferences and newer answers take priority.",
  "creator.learning.memoryCount": "Based on {count} older answers",
  "creator.learning.audience": "Who you are writing for",
  "creator.learning.goals": "What you are trying to achieve",
  "creator.learning.voice": "How it should sound",
  "creator.learning.notSet": "Not set",
  "creator.learning.answersHeading": "Recent answers",
  /** How many, against the ceiling the analyzer actually applies. */
  "creator.learning.answerCount": "{count} of up to {limit}",
  "creator.learning.noAnswers": "No previous answers yet.",
  "creator.learning.youLabel": "You",
  "creator.learning.untitled": "Untitled content",
  /**
   * **Said because the list above is deliberately short.** An analysis carries
   * more than this panel shows, and a reader who assumed otherwise would think
   * their edits were being ignored.
   */
  "creator.learning.detailNote":
    "An analysis may also use the reasons given, the post texts, your edited versions, and a short extract of each piece.",

  /**
   * What somebody actually chose, in the words they chose it with.
   *
   * **The stored value is not the sentence.** `approve` means "post this" on a
   * recommendation and "yes, leave it" on a skip; showing the column would ask
   * the reader to translate a database value before they could recognise their
   * own decision. There is no `skip` + `edit` pair — the repository refuses one.
   */
  "creator.learning.action.usedAsIs": "Used as-is",
  "creator.learning.action.editedAndUsed": "Edited and used",
  "creator.learning.action.rejected": "Rejected",
  "creator.learning.action.agreedWithSkip": "Agreed with skip",
  "creator.learning.action.wouldPost": "Would post",

  "worker.detail.noDescription": "No description.",
  "worker.detail.workerType": "Worker type",
  "worker.detail.metadataDescription": "A worker and its schedule.",
  /** A kind stored by a version this one cannot read. It says so; it does not guess. */
  "worker.detail.unrecognised": "Unrecognised",
  "worker.detail.lastRun": "Last Run",
  "worker.detail.createdAt": "Created At",
  "worker.detail.updatedAt": "Updated At",
  "worker.detail.watchedPage": "Watched page",
  /**
   * What a discovery worker is configured to do, on the page that reports it.
   *
   * **`discoverySource` names where it looks and is not a setting.** One
   * provider exists and the form does not offer a choice; the row is here
   * because a worker's page should say where its results came from, and because
   * a second provider would otherwise arrive as an unexplained change.
   */
  "worker.detail.discoverySource": "Where it looks",
  "worker.detail.discoveryQuery": "What to look for",
  "worker.detail.discoveryMaxResults": "How many to recommend",
  /**
   * The way from a worker to one of its executions.
   *
   * Named for what it lists rather than for what it is for — the reason a run
   * failed is on the run's own page, and this is how somebody gets there once
   * the account's activity list has moved on past it.
   */
  "worker.detail.runHistory": "Run History",
  /**
   * **"Older runs", not "Load more".** Following this is a navigation to a
   * different page of history, not an append to the list already on screen —
   * and a reader who was told the list would grow would be looking for rows
   * that are no longer there.
   */
  "worker.detail.olderRuns": "Older runs",
  "worker.detail.backToLatestRuns": "Back to latest",
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
  "worker.edit.metadataDescription": "Update an AI worker.",
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
  "run.detail.metadataDescription":
    "Details of a single worker execution.",
  "run.detail.back": "Back to Workers",
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
  /**
   * What a discovery worker is missing, said one field at a time.
   *
   * **"Unknown" rather than "invalid" for the source**, because a source this
   * deployment does not have is not a mistake in what was typed — it names
   * something real that Koqentra cannot ask yet, and the two deserve different
   * words.
   */
  "worker.validation.discoverySourceRequired": "Choose where to search.",
  "worker.validation.discoverySourceUnknown":
    "Koqentra cannot search that source.",
  "worker.validation.discoveryQueryRequired": "Enter what to search for.",
  "worker.validation.discoveryMaxResultsRange":
    "Choose how many to recommend, from 1 to {limit}.",
  /**
   * Said when a deployment has no key for the source that was chosen.
   *
   * **It says the search cannot be made, not that the account did something
   * wrong.** Nothing about the submission is at fault, and nobody reading this
   * can fix it by changing a field — so it is the form's own message rather
   * than one attached to a control.
   */
  "worker.validation.discoveryUnavailable":
    "Searching that source is not available on this deployment.",
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
  /**
   * The same answer for a discovery worker whose search is missing.
   *
   * **It does not offer to make one.** A search Koqentra invented would be a
   * search nobody chose, running on a schedule somebody else set.
   */
  "worker.action.noSearchConfigured":
    "This worker has no search configured, so it cannot be saved.",
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
   * What a discovery run that chose nothing says.
   *
   * **A statement about this search, not about the world.** A run that chose
   * nothing cannot tell apart a source with nothing in it, a source whose every
   * result had already been recommended, and a model that judged none of them
   * worth it — so it says what it can stand behind: nothing was found for this
   * search.
   */
  "run.system.discoveryNoSelection":
    "No recommendations were found for this search.",

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
  "run.action.entitlementBlocked":
    "This run isn't available with your current plan status. Check Plans to continue.",
  /**
   * Refusals from the AI processing allowance, shared by every place that asks
   * a model on the account's behalf: a worker run, a draft and a Creator
   * analysis. Not the hourly limits, which say that waiting works.
   */
  "run.action.manualRunLimitReached":
    "You've reached this period's manual run limit. Check Plans for your allowance.",
  "run.action.discoveryLimitReached":
    "You've reached this period's recommendation run limit. Check Plans for your allowance.",
  "ai.allowance.exhausted":
    "You've reached your AI processing limit for this period. Check Plans for your allowance.",
  "ai.allowance.unavailable":
    "AI processing isn't available with your current plan status. Check Plans to continue.",
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
  /**
   * The second allowance, said as its own sentence.
   *
   * **Not the same message as the one above.** Somebody told they have reached
   * the manual run limit and can still run other workers would reasonably
   * think something is broken; what has actually happened is that searching
   * costs more than running, and only searching is out.
   */
  "run.action.discoveryRateLimited":
    "Search limit reached for now. Try again later.",
  "run.action.couldNotStart":
    "\"{name}\" could not be started. Try again in a moment.",
  "run.action.outcomeNotRecorded":
    "\"{name}\" started, but its outcome could not be recorded.",
  "run.action.failed": "\"{name}\" failed to run.",
  "run.action.succeeded": "\"{name}\" ran successfully.",

  "settings.title": "Settings",
  "settings.metadataDescription": "Account settings.",
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
   * What Koqentra is told before it judges anything.
   *
   * **Stated by a person, not inferred from one.** These three lines are the
   * only preferences the product has; nothing watches somebody and writes a
   * profile for them. That is why the section says what it will be used for
   * rather than what has been noticed.
   *
   * `settings.creator.priorityNote` describes the analyzer's actual ordering —
   * stated preferences sit above patterns in past answers — and stops there.
   * **It must not promise obedience or a result**, because neither is
   * something a model call can be held to.
   */
  "settings.creator.title": "Creator preferences",
  "settings.creator.description":
    "What Koqentra should assume about your writing when it decides where a piece belongs and drafts a post.",
  "settings.creator.audience": "Who you want to reach",
  "settings.creator.audiencePlaceholder":
    "e.g. Parents of young children in my area",
  "settings.creator.goals": "What you want your content to achieve",
  "settings.creator.goalsPlaceholder":
    "e.g. Get the information they need to them clearly",
  "settings.creator.voice": "Writing style and voice",
  "settings.creator.voicePlaceholder":
    "e.g. Short and factual. No hype.",
  "settings.creator.priorityNote":
    "What you set here takes priority over patterns in your recent answers when Koqentra analyses a piece.",
  "settings.creator.saved": "Creator preferences saved.",
  "settings.creator.failed": "Could not save your creator preferences.",
  "settings.creator.tooLong":
    "\u201c{field}\u201d is too long. Keep it to {limit} characters or fewer.",

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
  /**
   * The trial, in the words somebody reading a screen uses.
   *
   * **Every quantity is written "used / limit", never as a remainder.** A trial
   * can legitimately begin past its AI limit — what an account spent before it
   * started is carried in — and "27 remaining" has no honest reading at 43/30.
   * One format that is always true is worth more than two that are usually
   * shorter.
   *
   * **None of this stops anything.** "Limit reached" describes a number; the
   * account works exactly as it did the day before. Wording that implied
   * otherwise would be a promise this version does not keep.
   *
   * **Deliberately not the rate-limit copy.** An hourly allowance comes back
   * by waiting and says so; a plan's does not, so "try again later" would be
   * advice that never works. The two never share a key.
   */
  "trial.title": "Trial",
  "trial.daysRemaining": "{days} days left",
  "trial.usage.aiProcessing": "AI processing",
  "trial.usage.activeWorkers": "Workers active at once",
  "trial.usage.manualRun": "Manual runs",
  "trial.usage.discovery": "Recommendation runs",
  "trial.status.approaching": "Approaching the limit",
  "trial.status.reached": "Limit reached",
  "trial.status.over": "Over the limit",
  /**
   * Why a trial can start already past its AI limit.
   *
   * **Said where the number is**, because the number is the surprising part.
   * Somebody seeing 63/50 on the day they started is owed the reason on the
   * same card rather than in a help page.
   */
  "trial.carriedIn":
    "AI processing used before your trial started has been carried over.",
  "trial.started": "Your trial has started",
  /**
   * What an ended trial says.
   *
   * **The two fears, answered first.** Somebody whose free period just ended
   * wants to know whether their work is gone and whether they have been
   * charged. Neither has happened; saying so plainly is the whole message.
   *
   * **No upgrade button, because there is nowhere to send anybody yet.** A
   * call to action leading to a page that does not exist is worse than none.
   */
  "trial.expired.title": "Your trial has ended",
  "trial.expired.retained":
    "Your Workers, history, and settings are still saved. Nothing was deleted and you have not been charged.",
  /**
   * Said on the hire form, where the trial actually starts.
   *
   * **Before the activation rather than after it.** Activating the first
   * Worker starts the fourteen days, so the sentence belongs beside the
   * control that does it.
   */
  "trial.preStart.explanation":
    "Your 14-day free trial starts when you activate your first Worker.",
  "trial.preStart.carryIn":
    "Your {used} previous AI processing uses will carry into the trial ({used}/{limit} at start).",

  /**
   * The same hire, when it also began the account's fourteen days.
   *
   * **Two facts in one sentence rather than two messages.** Somebody who has
   * just activated their first Worker has done one thing; telling them twice
   * would suggest otherwise. The detail — what has been used against what —
   * lives on the dashboard card, which is where it stays true.
   */
  "worker.action.createdWithTrial":
    "Worker \"{name}\" created. Your trial has started.",
  "worker.action.savedWithTrial": "Worker \"{name}\" saved. Your trial has started.",

  /**
   * The two things a notification is for: the page that moved, and the run
   * that noticed.
   *
   * **The watched page comes first, and that ordering is the point.** Somebody
   * who has just been told a hotel has rooms wants the hotel, not Koqentra;
   * making them open the dashboard to find an address they configured weeks
   * ago is friction charged against the thing the notification exists to
   * enable. Koqentra's own page is offered second, for the reading rather than
   * the acting.
   */
  "notify.email.openMonitored": "Open monitored page:",
  /** On the run's own page, beside what the run found. */
  "run.detail.openMonitored": "Open monitored page",

  /**
   * Plans, and what a lower allowance means for workers already running.
   *
   * **The guardrail wording says what will and will not happen, in that order.**
   * Somebody reading it is deciding whether to buy, and the thing they need
   * first is that nothing of theirs stops — the restriction comes second because
   * it is the smaller surprise. **Nothing here names the Closed Beta**: the same
   * sentences serve a trial, a granted allowance and a plan somebody is leaving.
   */
  "pricing.title": "Plans",
  "pricing.description":
    "What each plan allows. Prices are per month.",
  "pricing.current.heading": "Your plan",
  "pricing.current.none": "You are not on a plan yet.",
  /**
   * What the account has, said one way per state.
   *
   * **A plan and a live entitlement are different facts.** The first version of
   * this screen said "You are on Lite" for an account whose Lite subscription had
   * ended, because it read the plan and ignored the state — and a plan is what
   * *was* allowed as much as what is. Each state below therefore gets its own
   * sentence, and the three that entitle nothing say so first.
   *
   * **Granted and bought are different too.** The Closed Beta's accounts have an
   * allowance nobody paid for; telling them they are subscribed would be telling
   * them they are being charged.
   */
  "pricing.current.trialing": "Your trial is active.",
  "pricing.current.trialExpired": "Your trial has ended.",
  "pricing.current.activeGranted": "Your {plan} access is active.",
  "pricing.current.activePurchased": "You are subscribed to {plan}.",
  /**
   * **Says what needs doing, not what went wrong.** The provider reports a
   * payment that has not settled; whether a card was declined, expired or simply
   * slow is not something this screen knows, and naming a cause it cannot see
   * would be worse than naming none.
   */
  "pricing.current.grace":
    "Your {plan} subscription is active, but payment needs attention.",
  "pricing.current.cancelledActive":
    "Your {plan} subscription is cancelled but remains active until the end of the current billing period.",
  "pricing.current.inactive":
    "You are not on a plan. Your {plan} subscription has ended.",
  "pricing.current.expired": "Your {plan} access has ended.",
  "pricing.current.unreadable":
    "Your plan cannot be shown right now. Nothing has changed.",
  "pricing.current.activeWorkers":
    "{count} of your Workers are active.",
  "pricing.managed.heading": "Managing your subscription",
  "pricing.managed.description":
    "Changing or cancelling a plan you pay for is not available yet. Email support and somebody will do it for you.",
  "pricing.managed.portalDescription":
    "Manage your payment method and subscription in Stripe's secure billing portal.",
  "pricing.portal.manage": "Manage subscription",
  "pricing.portal.pending": "Opening...",
  "pricing.portal.message.notEligible":
    "There is no subscription to manage here.",
  "pricing.portal.message.unavailable":
    "The billing portal cannot be opened right now. Nothing has changed.",
  "pricing.plan.trial": "Trial",
  "pricing.plan.lite": "Lite",
  "pricing.plan.standard": "Standard",
  "pricing.plan.pro": "Pro",
  "pricing.plan.beta": "Beta",
  "pricing.price.monthly": "¥{amount} / month",
  "pricing.allowance.activeWorkers": "Workers active at once: {limit}",
  "pricing.allowance.aiProcessing": "AI processing: {limit} a month",
  "pricing.allowance.manualRun": "Manual runs: {limit} a month",
  "pricing.allowance.discovery": "Recommendation runs: {limit} a month",
  "pricing.allowance.emailOneWorker": "Email from one Worker",
  "pricing.allowance.emailAllWorkers": "Email from every Worker",
  "pricing.allowance.historyDays": "{days} days of run history",
  "pricing.cta.comingSoon": "Not available yet",
  "pricing.standing.atLimit": "This is exactly what you use now",
  "pricing.standing.overLimit": "Fewer active Workers than you run now",
  /**
   * What happens to workers that are already running.
   *
   * **Read in the order it is written.** Nothing of yours stops; then what you
   * cannot do until you free a slot; then how to free one. A reader who stops
   * after the first line has the answer that matters most.
   */
  /**
   * The button that starts a purchase, and the words for every way it can end.
   *
   * **"Choose" rather than "Buy" or "Subscribe".** Pressing it opens the
   * provider's page, where the money is actually agreed to; a label promising a
   * purchase would be describing the step after this one.
   *
   * **Nothing here names the provider.** Which company takes the payment is
   * visible on the page that takes it, and putting it on a button would make the
   * product's own screen advertise somebody else's.
   */
  "pricing.cta.choose": "Choose {plan}",
  "checkout.pending": "Opening checkout...",
  /**
   * The over-limit confirmation, shown only when the server asks for it.
   *
   * **The sentences are the card's own.** What happens to workers already
   * running is the same fact whether it is being previewed or agreed to, and a
   * second wording of it would be a second thing to keep true. What is added
   * here is the asking.
   */
  "checkout.confirm.heading": "Before you continue",
  "checkout.confirm.accept": "I understand — continue",
  "checkout.confirm.cancel": "Cancel",
  /**
   * The purchase terms, shown after a plan is chosen and before anything is
   * asked of the server. The same facts the legal notice states, in its words.
   */
  "checkout.terms.heading": "Review your purchase",
  "checkout.terms.plan.term": "Plan",
  "checkout.terms.plan.detail": "{plan} ({price})",
  "checkout.terms.contract.term": "Contract term",
  "checkout.terms.contract.detail":
    "A monthly, continuing subscription. It renews automatically every month, counted from the date the subscription started.",
  "checkout.terms.paymentTiming.term": "When payment is taken",
  "checkout.terms.paymentTiming.detail":
    "First payment when the paid plan starts; after that, every month, counted from the date the subscription started.",
  "checkout.terms.paymentMethod.term": "Payment method",
  "checkout.terms.paymentMethod.detail":
    "The payment methods shown as available on Stripe Checkout.",
  "checkout.terms.delivery.term": "When the service is provided",
  "checkout.terms.delivery.detail": "Once the payment has been successfully applied.",
  "checkout.terms.cancellation.term": "Cancellation",
  "checkout.terms.cancellation.detail": "You can cancel from the Stripe Billing Portal.",
  "checkout.terms.afterCancellation.term": "After cancelling",
  "checkout.terms.afterCancellation.detail":
    "You can keep using the plan until the end of the current billing period.",
  "checkout.terms.refunds.term": "Refunds",
  "checkout.terms.refunds.detail":
    "As a rule, payments are not refunded. Duplicate charges, clear payment errors, cases where a refund is required by law, and other cases we judge necessary are handled individually.",
  "checkout.terms.proceed": "Review and continue to Stripe",
  "checkout.terms.back": "Back",
  /**
   * What each refusal says, and what none of them says.
   *
   * **No cause, no identifier, no provider text.** A session id, an attempt id
   * or the provider's own message would each be this screen describing the
   * inside of a payment system to whoever pressed a button. Each sentence says
   * what happened and what to do, and stops there.
   */
  "checkout.message.planSwitch":
    "A checkout for a different plan is already open. Finish or leave it, and this page will let you choose again shortly.",
  "checkout.message.billingManagement":
    "Your subscription needs managing rather than replacing, and that is not available from this screen yet.",
  "checkout.message.paymentProcessing":
    "A payment is still being confirmed. Nothing new was started — please check back in a few minutes.",
  "checkout.message.providerUnavailable":
    "Your subscription could not be checked just now. Nothing was charged and nothing was started. Please try again.",
  "checkout.message.unavailable":
    "Checkout is not available right now. Nothing was charged and nothing has changed.",
  "checkout.message.invalidRequest":
    "That request could not be read. Nothing was charged and nothing has changed.",
  /**
   * Coming back from a payment page, before Koqentra knows about it.
   *
   * **Nothing here claims a purchase succeeded.** The provider redirects when a
   * card clears; the entitlement is written afterwards by a reconciliation run,
   * measured at 52 seconds in production and bounded by a five-minute cron
   * cadence. For that window the only honest thing to say is that the payment
   * arrived and the plan is being confirmed — so the success sentence is behind a
   * bought plan actually being active, and the waiting sentence never promises
   * one.
   *
   * **Running out of time is not a failure, and is not worded as one.** A
   * payment that has not appeared may still appear; telling somebody it failed
   * would invite them to pay twice.
   */
  "checkout.return.title": "Your payment",
  "checkout.return.description":
    "What happens between paying and your plan being ready.",
  "checkout.return.pending.heading": "Payment received.",
  "checkout.return.pending.body": "Confirming your plan...",
  "checkout.return.pending.patience": "This can take a few minutes.",
  "checkout.return.active.heading": "Your {plan} plan is active.",
  "checkout.return.active.body":
    "Nothing else is needed. Your allowances apply from now.",
  /**
   * **Said when a payment did not produce an active bought plan**, which also
   * covers a subscription that landed behind on payment or already cancelled.
   * Those have precise wording on the plans page, and repeating it here in a
   * second voice would be a second thing to keep true.
   */
  "checkout.return.notEntitled.heading": "No active plan to show yet",
  "checkout.return.notEntitled.body":
    "We could not confirm an active plan from this payment. The Plans page shows what your account is on now.",
  "checkout.return.timedOut.heading": "Still confirming your payment",
  "checkout.return.timedOut.body":
    "Your payment is still being confirmed. Please check Plans again in a few minutes. If it still has not updated, contact support.",
  "checkout.return.goToPlans": "Go to Plans",
  /**
   * Said on the plans page while a checkout of this account's is unfinished.
   *
   * **It explains rather than blocks.** The buttons stay usable, because an
   * unfinished checkout is as likely to be one somebody abandoned at the payment
   * page — pressing again resumes that same session — as one they paid for. What
   * was missing was any acknowledgement that a payment may be in flight, which is
   * what made a correctly-reported "your subscription has ended" so alarming.
   */
  "pricing.checkoutInProgress":
    "A checkout of yours is still open. If you have just paid, your plan can take a few minutes to appear here.",
  /**
   * Shown above the plans only to an account in its trial that may buy. What a
   * purchase does to the trial is decided in `lib/billing` and is not
   * restated anywhere else on the page.
   */
  "pricing.allowanceGuide.heading": "About your allowances",
  "pricing.allowanceGuide.activeWorkers.title": "Workers active at once",
  "pricing.allowanceGuide.activeWorkers.body":
    "How many workers can be switched on at the same time. Paused and draft workers do not count. You can keep up to 20 workers in total.",
  "pricing.allowanceGuide.aiProcessing.title": "AI processing",
  "pricing.allowanceGuide.aiProcessing.body":
    "How many times an AI is asked to generate, summarize or analyze something for you. This is not the same as the number of worker runs: a page watch uses it only when the page changed, and a recommendation search only when there are new candidates to choose from. Some actions, such as a Creator analysis, can use more than one at a time.",
  "pricing.allowanceGuide.manualRun.title": "Manual runs",
  "pricing.allowanceGuide.manualRun.body":
    "How many times you can run a worker by hand. Scheduled runs do not use this allowance.",
  "pricing.allowanceGuide.discovery.title": "Recommendation runs",
  "pricing.allowanceGuide.discovery.body":
    "How many times a \"Find recommendations\" worker can run. Running one by hand also uses a manual run, and choosing among new candidates with AI also uses AI processing.",
  "pricing.legal.terms": "Terms of Service",
  "pricing.legal.notice": "Legal notice (特定商取引法に基づく表記)",
  "pricing.trialPurchaseNotice":
    "Starting a paid plan during your trial ends the free trial at that point. The remaining trial days are not carried over, and the paid plan's allowance starts from zero.",
  "pricing.guardrail.atLimit.title": "You would be at this plan's limit",
  "pricing.guardrail.atLimit.body":
    "{active} of your Workers are active and this plan allows {limit}. They keep running. To make another Worker active — including one that is paused — you would first have to pause one.",
  "pricing.guardrail.overLimit.title": "This plan allows fewer active Workers",
  "pricing.guardrail.overLimit.keepsRunning":
    "{active} of your Workers are active and this plan allows {limit}. The ones running now keep running: nothing is stopped, and Koqentra never chooses a Worker to stop on your behalf.",
  "pricing.guardrail.overLimit.restricted":
    "Until fewer than {limit} are active, you could not make a new Worker active, activate a draft, or resume a paused one.",
  "pricing.guardrail.overLimit.recovery":
    "Pausing or deleting a Worker is always allowed, and once fewer than {limit} are active you could add them again.",

} as const;

/**
 * Every key a translation may hold, and every key it must.
 *
 * Derived rather than declared, so the list cannot drift from the English copy
 * it describes.
 */
export type TranslationKey = keyof typeof en;
