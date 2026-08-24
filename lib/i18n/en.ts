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

  "settings.language.title": "Language",
  "settings.language.description":
    "The language AutoOps uses for its own screens. Your workers and what they produce are unaffected.",
  "settings.language.label": "Language",
  "settings.language.english": "English",
  "settings.language.japanese": "Japanese",
  "settings.language.save": "Save",
  "settings.language.saving": "Saving…",
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
