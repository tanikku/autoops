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
  "worker.field.runAt": "Run at",
  "worker.field.timezoneNote":
    "Times use your account timezone: {timezone}. Leave empty to run at whatever time the worker was saved.",

  "worker.create.description":
    "Define the worker once. AutoOps runs it on your schedule.",
  "worker.create.draftHeading": "What would you like AutoOps to handle?",
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
  "worker.create.templatesHeading": "Choose a Template",
  "worker.create.templatesHelp":
    "Start from a template, or fill in the form below yourself.",

  /**
   * Why drafting produced nothing.
   *
   * **All six are AutoOps speaking, which is what lets them be translated.**
   * What a generator returns for `unsupported` or `needs_input` is a sentence
   * the model wrote about a particular request; it goes to the screen exactly
   * as it arrived and has no key here.
   */
  "worker.draft.notConfigured":
    "Drafting is unavailable because AutoOps has no AI configured.",
  "worker.draft.empty": "Describe what you would like AutoOps to handle.",
  "worker.draft.tooLong": "Keep the description under {limit} characters.",
  "worker.draft.timeout": "Drafting took too long. Try again.",
  "worker.draft.unavailable": "The AI service could not be reached. Try again.",
  "worker.draft.unreadable":
    "AutoOps could not read the answer. Try describing the work again.",

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
    "successful check, AutoOps establishes a new baseline instead of treating " +
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
  "run.action.noWorkerSelected": "No worker selected.",
  "run.action.alreadyRunning": "\"{name}\" is already running.",
  "run.action.outcomeNotRecorded":
    "\"{name}\" started, but its outcome could not be recorded.",
  "run.action.failed": "\"{name}\" failed to run.",
  "run.action.succeeded": "\"{name}\" ran successfully.",

  "settings.title": "Settings",
  "settings.description":
    "How AutoOps reads and schedules times for your account.",
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
    "The language AutoOps uses for its own screens. Your workers and what they produce are unaffected.",
  "settings.language.label": "Language",
  "settings.language.english": "English",
  "settings.language.japanese": "Japanese",
  "settings.language.saved": "Language saved.",
  "settings.language.invalid": "Select a language from the list.",
  "settings.language.failed": "Could not save your language.",
} as const;

/**
 * Every key a translation may hold, and every key it must.
 *
 * Derived rather than declared, so the list cannot drift from the English copy
 * it describes.
 */
export type TranslationKey = keyof typeof en;
