import "server-only";

import {
  isEmailDeliveryError,
  sendPlainTextEmail,
  type EmailDeliveryFailure,
} from "@/lib/notify/email";
import { formatDateTime } from "@/lib/datetime";
import { t, type TranslationKey } from "@/lib/i18n";
import { getNotificationRecipient } from "@/lib/users";
import { workerFieldLimits } from "@/lib/worker-input";

/**
 * Telling the owner of a worker what one of its runs came to.
 *
 * **Best effort, and after the fact.** Everything here happens once the run's
 * final state is in the database: the order is execution, then persistence,
 * then this. Sending first would make "the email arrived and the run is not
 * there" reachable, and a reader following a link to nothing has been told
 * something false about their own account.
 *
 * **Nothing here can change a run.** This module writes no row, throws nothing
 * at its caller, and returns nothing it could be asked about — a provider that
 * is down, misconfigured or slow leaves a `completed` run completed and a
 * `failed` run's reason exactly as it was recorded.
 *
 * **What is sent is composed here and the words come from the dictionary.**
 * The account's own material — the worker's name, a model's summary, a prompt
 * worker's output — travels as it is: it is what somebody asked for, in
 * whatever language they asked for it in, and translating it would be us
 * rewriting their work.
 */

/**
 * What a finished run is worth telling somebody about.
 *
 * **Three, and the set is closed because the policy is.** A website worker's
 * first check and one that found nothing are not here at all — they are
 * successful runs with nothing to report, and an email about them would arrive
 * every cadence for as long as the page sat still.
 */
export type RunNotificationKind =
  /** A watched page moved, and a model has said what changed. */
  | "website-changed"
  /** A prompt worker's run finished, whatever it produced. */
  | "prompt-completed"
  /** A run of either kind failed, and the reason is on its own page. */
  | "failed";

/** One finished run, as much of it as an email is allowed to know. */
export type RunNotification = {
  runId: string;
  routineId: string;
  /** The owner, taken from the routine — never from a session or a form. */
  userId: string;
  workerName: string;
  kind: RunNotificationKind;
  /** When the run ended, or when it was observed to have ended. */
  finishedAt: Date;
  /**
   * What the run produced, for the two kinds that have one.
   *
   * **Never `errorMessage`, and a failure carries no output at all.** A
   * failure's stored reason is a diagnostic in whatever wording it arrived
   * with — a provider's own sentence, or a driver's — and only some of those
   * were written to be read by the person whose worker it is. Telling those
   * apart in an email would be a second classification of the same failure,
   * kept in step with the first by hand; a failed run's message says that it
   * failed and links to the page where the reason is shown as recorded.
   */
  output: string;
};

/**
 * Why a notification did not go out, including the reasons that are not the
 * provider's.
 *
 * **One vocabulary for the log line, so an operator reading `[notify] could
 * not send` never has to know which layer it came from.** The provider's own
 * set is carried through unchanged rather than re-mapped.
 */
type NotificationFailure =
  | EmailDeliveryFailure
  /** The owner's row or address could not be read. */
  | "recipient-unknown"
  /** `AUTH_URL` is unset or not an address a link can be built from. */
  | "link-unavailable"
  /** Anything this module did not anticipate. */
  | "unknown";

/** A step before the provider that could not be completed. */
class NotificationSetupError extends Error {
  readonly reason: NotificationFailure;

  constructor(reason: NotificationFailure) {
    super(`Notification could not be prepared: ${reason}.`);
    this.name = "NotificationSetupError";
    this.reason = reason;
  }
}

/**
 * How much of a run's output an email carries.
 *
 * **A message, not an archive.** The whole of it is on the run's own page and
 * the email links there; what this decides is how much arrives without asking.
 * Two thousand characters is several screens of reading in either language and
 * well short of what a mail client will fold or a provider will refuse.
 */
export const MAX_NOTIFIED_OUTPUT_CHARS = 2_000;

const SUBJECT_KEYS: Record<RunNotificationKind, TranslationKey> = {
  "website-changed": "notify.email.changedSubject",
  "prompt-completed": "notify.email.completedSubject",
  failed: "notify.email.failedSubject",
};

/**
 * Tells the owner, and never says whether it managed to.
 *
 * **The one entry point, and it cannot throw.** Its caller is `runRoutine`,
 * which has already recorded the run's outcome by the time this is reached —
 * anything escaping from here would travel up a path whose whole contract is
 * that the outcome has been decided. Every failure ends as one log line.
 *
 * **The line names the run and the worker and nothing else.** No address, no
 * key, no header, no provider response, no output, and no page content: the
 * two ids are enough to find the run in the database, and everything worth
 * knowing about it is already there.
 */
export async function notifyRunOutcome(
  notification: RunNotification,
): Promise<void> {
  try {
    await deliver(notification);
  } catch (error) {
    console.error(
      "[notify] could not send",
      `run=${notification.runId}`,
      `worker=${notification.routineId}`,
      `reason=${classify(error)}`,
    );
  }
}

/** One of the closed set, for the log. Never the thrown value itself. */
function classify(error: unknown): NotificationFailure {
  if (isEmailDeliveryError(error)) {
    return error.reason;
  }

  return error instanceof NotificationSetupError ? error.reason : "unknown";
}

/**
 * Works out who to write to, what to say, and says it.
 *
 * Every step that cannot be completed throws, and the caller above turns that
 * into a line. Nothing is retried and nothing is queued for later — see the
 * duplicate note in the README: one run gets at most one attempt.
 */
async function deliver(notification: RunNotification): Promise<void> {
  let recipient: Awaited<ReturnType<typeof getNotificationRecipient>>;
  try {
    recipient = await getNotificationRecipient(notification.userId);
  } catch {
    // A database that will not answer is not a run that went wrong. The
    // driver's own complaint is dropped rather than logged here: it names
    // tables and connection strings, and the line above is about a
    // notification.
    throw new NotificationSetupError("recipient-unknown");
  }

  if (recipient === null) {
    throw new NotificationSetupError("recipient-unknown");
  }

  const { language, timezone } = recipient;
  const url = runDetailUrl(notification.runId);
  const name = subjectSafeName(notification.workerName);

  await sendPlainTextEmail({
    to: recipient.email,
    subject: t(language, SUBJECT_KEYS[notification.kind], { name }),
    text: body(notification, language, timezone, url),
  });
}

/**
 * The worker's name, as a subject line may carry it.
 *
 * **Not a security measure, and saying otherwise would overstate it.** The
 * request is a JSON document, so there is no header for a newline to break out
 * of; what this fixes is a subject that reads as broken. `readWorkerForm` trims
 * a name and bounds its length, and neither of those stops a newline in the
 * middle — nor does anything stop a row written before those rules existed.
 *
 * Control and format characters become a space, runs of whitespace collapse,
 * and the result is cut to the same ceiling the form enforces so that one
 * stored longer cannot produce a subject line nothing will show.
 */
function subjectSafeName(name: string): string {
  const cleaned = name
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  return cleaned.slice(0, workerFieldLimits.name);
}

/**
 * The absolute address of the run's own page.
 *
 * **Built with `URL` rather than by joining strings**, so a base written with
 * or without a trailing slash produces the same link and neither produces
 * `//dashboard`.
 *
 * **An unusable `AUTH_URL` is a delivery failure, not a run failure.** A
 * message whose only actionable part is a broken link is worse than no message,
 * and the run it describes is recorded either way.
 */
function runDetailUrl(runId: string): string {
  const base = process.env.AUTH_URL?.trim();

  if (!base) {
    throw new NotificationSetupError("link-unavailable");
  }

  let url: URL;
  try {
    url = new URL(`/dashboard/runs/${runId}`, base);
  } catch {
    throw new NotificationSetupError("link-unavailable");
  }

  // A base that parses but is not something a reader can open — `mailto:`,
  // `file:` — is as unusable as one that does not parse at all.
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new NotificationSetupError("link-unavailable");
  }

  return url.toString();
}

/**
 * The whole message, as plain text.
 *
 * **Composed in the account's language, around material that is not
 * translated.** The labels and the closing line are AutoOps talking; the
 * worker's name and whatever the run produced are the account's, and they are
 * placed into the message exactly as they are stored.
 */
function body(
  notification: RunNotification,
  language: string,
  timezone: string,
  url: string,
): string {
  const time = formatDateTime(notification.finishedAt, timezone);

  const lines = [
    "AutoOps",
    "",
    t(language, "notify.email.worker", { name: notification.workerName }),
    t(
      language,
      notification.kind === "website-changed"
        ? "notify.email.detectedAt"
        : "notify.email.executedAt",
      { time },
    ),
    "",
    notification.kind === "failed"
      ? t(language, "notify.email.failedBody")
      : outputSection(notification.output, language),
    "",
    t(language, "notify.email.viewRun"),
    url,
  ];

  return `${lines.join("\n")}\n`;
}

/**
 * What the run produced, cut to what an email carries.
 *
 * **An empty output is still a finished run**, and it is left empty rather than
 * described: a prompt worker that answered with nothing has answered, and
 * saying so on its behalf would be AutoOps writing something the model did not.
 */
function outputSection(output: string, language: string): string {
  if (output.length <= MAX_NOTIFIED_OUTPUT_CHARS) {
    return output;
  }

  return `${output.slice(0, MAX_NOTIFIED_OUTPUT_CHARS)}\n\n${t(
    language,
    "notify.email.truncated",
  )}`;
}
