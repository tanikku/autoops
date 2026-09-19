import {
  DISCOVERY_MAX_RESULTS_CEILING,
  DISCOVERY_QUERY_MAX_CHARS,
} from "@/lib/discovery/limits";
import { isDiscoverySourceKind } from "@/lib/discovery/types";
import { DEFAULT_LANGUAGE, t, type TranslationKey } from "@/lib/i18n";
import {
  isRoutineFrequency,
  isRoutineKind,
  isRoutineStatus,
  type RoutineFrequency,
  type RoutineKind,
  type RoutineStatus,
} from "@/types";

/**
 * Upper bounds for the free-text fields.
 *
 * Each is set by what the field has to survive downstream rather than by what
 * the column can hold — the database would take far more:
 *
 * - `name` appears in cards, toasts and page titles, so it has to stay
 *   readable when truncated.
 * - `description` is a sentence or two under the name; longer belongs in the
 *   prompt.
 * - `prompt` is sent to the model on every run, so its length is a cost and
 *   latency ceiling as much as a storage one. 10,000 characters is roughly
 *   2,500–5,000 tokens: ample for instructions, far short of a context limit.
 * - `websiteUrl` is 8,192 because that is where the web itself gives out: it is
 *   the request-line length common servers and proxies stop at, so an address
 *   longer than this is one nothing would answer anyway. It is the only limit
 *   here set by something outside AutoOps.
 */
export const workerFieldLimits = {
  name: 100,
  description: 500,
  prompt: 10_000,
  websiteUrl: 8_192,
  /**
   * **Not a number of this file's own.** The search a discovery worker sends is
   * bounded by `DISCOVERY_QUERY_MAX_CHARS`, decided in C2.19C alongside the
   * other discovery limits; this entry is what puts a counter beside the box
   * and gives the length message the same wording every other field gets.
   */
  discoveryQuery: DISCOVERY_QUERY_MAX_CHARS,
} as const;

export type WorkerFieldName = keyof typeof workerFieldLimits;

/**
 * Field-level messages, keyed by field. Empty means the input is acceptable.
 *
 * **`status` carries messages without being one of the fields above.** Those
 * are the ones with a length to count against (`workerFieldLimits`), and a
 * dropdown has none; what it does have is a rule that can reject it — the
 * account's active-worker limit — and the message for that belongs beside the
 * control it is about rather than in a toast on its own. `DiscoveryFieldName`
 * is here for the same reason.
 */
export type WorkerFieldErrors = Partial<
  Record<WorkerFieldName | "status" | DiscoveryFieldName, string>
>;

/**
 * The two discovery fields that have no length to count against.
 *
 * **`discoveryQuery` is not among them**, because it does have one and is in
 * `workerFieldLimits` with the rest. These two are here for the same reason
 * `status` is: a rule can reject them, so a message has to be able to name
 * them, but there is no character count to show beside either.
 */
export type DiscoveryFieldName = "discoverySource" | "discoveryMaxResults";

/**
 * What each field is called inside a message about it.
 *
 * **The form's own labels, rather than a second set.** A length complaint that
 * named a field differently from the box it came from would be describing
 * something else — and in Japanese it would name it in English.
 */
const fieldLabelKeys: Record<WorkerFieldName, TranslationKey> = {
  name: "worker.field.name",
  description: "worker.field.description",
  prompt: "worker.prompt",
  websiteUrl: "worker.field.websiteUrl",
  discoveryQuery: "worker.field.discoveryQuery",
};

export type WorkerFormInput = {
  name: string;
  description: string;
  prompt: string;
  /**
   * The page to watch, or `""` for any submission that is not creating a
   * website worker.
   *
   * **Read through the kind rather than alongside it.** See `readWorkerForm`.
   */
  websiteUrl: string;
  /**
   * Where a discovery worker looks, what it looks for, and how many it keeps.
   *
   * **Read as submitted, like `websiteUrl`, and acted on only by whoever knows
   * the kind.** The same reasoning applies for the same reason: editing takes
   * the kind from the stored worker rather than from the submission, so a
   * reader that dropped these on the strength of the submitted kind would be
   * deciding from the field the boundary distrusts most.
   *
   * `discoveryMaxResults` is null when the field is absent or holds something
   * that is not a whole number in range — the create action turns that into the
   * default, and the validator turns an out-of-range number into a message.
   */
  discoverySource: string;
  discoveryQuery: string;
  discoveryMaxResults: number | null;
  /**
   * Whether the submission named the count at all.
   *
   * **"Did not say" and "said something wrong" are different answers**, and
   * `discoveryMaxResults` collapses them both into null. A form that leaves the
   * field out gets the default; one that asks for fifty is told the range. One
   * boolean is what keeps the validator from having to guess which happened.
   */
  discoveryMaxResultsSubmitted: boolean;
  /**
   * What the worker should do, or null when the form did not say.
   *
   * Null is not a synonym for `prompt`. A form that omits the field is either
   * one that has no business setting it — editing cannot change a kind — or a
   * submission that did not come from the create form; the create action tells
   * those apart by requiring a kind, and nothing defaults one.
   */
  kind: RoutineKind | null;
  /** null when the field is absent or holds a value the app does not accept. */
  status: RoutineStatus | null;
  frequency: RoutineFrequency | null;
  /** Minutes into the day, or null when no time was given. */
  runAtMinutes: number | null;
  /** 0 (Sunday) to 6 (Saturday), or null when no day was given. */
  runAtWeekday: number | null;
  /** 1 to 31, or null when no day was given. */
  runAtDay: number | null;
  /**
   * Whether the owner asked to be emailed about this worker's runs.
   *
   * **Not nullable, unlike the two enums above.** A checkbox that is not ticked
   * submits nothing at all, so "absent" is what "off" looks like on the wire —
   * there is no third state for a fallback to resolve, and inventing one would
   * make an omitted field mean something different on each form.
   */
  emailNotificationsEnabled: boolean;
};

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "").trim();
}

/**
 * Reads a checkbox, which submits a value only when it is ticked.
 *
 * **A closed list of the affirmatives rather than "anything not empty".** A
 * browser sends `on` for a checkbox with no value of its own, and the other two
 * are what a scripted submission or a test would plausibly send; everything
 * else — including a value nobody here chose — reads as off, which is the
 * setting that sends no mail.
 */
function checkbox(formData: FormData, field: string): boolean {
  const raw = text(formData, field).toLowerCase();
  return raw === "on" || raw === "true" || raw === "1";
}

const TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;

/**
 * Reads an `<input type="time">` value into minutes into the day.
 *
 * The browser submits `HH:mm`, but the field can be left blank and the value
 * arrives as a string either way, so anything unparseable becomes null — the
 * same as not choosing a time.
 */
function timeOfDay(formData: FormData, field: string): number | null {
  const match = TIME_PATTERN.exec(text(formData, field));
  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (hours > 23 || minutes > 59) {
    return null;
  }

  return hours * 60 + minutes;
}

/**
 * Reads a weekday from a select that submits its value as a string.
 *
 * An empty option means "no particular day", so anything outside 0–6 becomes
 * null rather than being clamped — a value that far off is not a near miss.
 */
function weekday(formData: FormData, field: string): number | null {
  return wholeNumberInRange(formData, field, 0, 6);
}

/**
 * Reads a bounded whole number from a select that submits strings.
 *
 * An empty option means "no particular one", so anything outside the range
 * becomes null rather than being clamped — a value that far off is not a near
 * miss, and the schedule module clamps what it reads from the database anyway.
 */
function wholeNumberInRange(
  formData: FormData,
  field: string,
  min: number,
  max: number,
): number | null {
  const raw = text(formData, field);
  if (raw === "") {
    return null;
  }

  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/** `540` → `09:00`, for putting a stored value back into the form. */
export function minutesToTimeValue(minutes: number | null): string | undefined {
  if (minutes === null) {
    return undefined;
  }

  const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
  return `${hours}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * Reads a worker out of submitted form data.
 *
 * Shared by the hire and edit actions so the two cannot drift: the fields
 * read, the trimming, and the treatment of an unrecognised status or frequency
 * are decided once. Callers supply their own fallback for the two nullable
 * fields, because "new worker" and "existing worker" default differently.
 */
export function readWorkerForm(formData: FormData): WorkerFormInput {
  const status = text(formData, "status");
  const frequency = text(formData, "frequency");
  const kind = text(formData, "kind");

  return {
    name: text(formData, "name"),
    description: text(formData, "description"),
    prompt: text(formData, "prompt"),
    // **Read as submitted, and acted on only by whoever knows the kind.**
    // Dropping it here on the strength of the submitted kind would work for a
    // new worker, where the form is the only thing that could say. It cannot
    // work for an existing one: editing must not take the kind from the
    // submission at all, so a reader that did would decide whether an address
    // exists from a field the boundary has already resolved to distrust.
    //
    // Nothing downstream reads this without a kind in hand — `validateWorkerForm`
    // is given one, and each action gates its writes on the same one — so a
    // prompt worker still cannot acquire a page to watch.
    websiteUrl: text(formData, "websiteUrl"),
    discoverySource: text(formData, "discoverySource"),
    discoveryQuery: text(formData, "discoveryQuery"),
    // **Out of range reads as null, not as the nearest allowed value.**
    // Clamping would save a submission asking for fifty by giving it ten, which
    // is answering a question nobody asked; the validator says what the range
    // is instead.
    discoveryMaxResults: wholeNumberInRange(
      formData,
      "discoveryMaxResults",
      1,
      DISCOVERY_MAX_RESULTS_CEILING,
    ),
    discoveryMaxResultsSubmitted: text(formData, "discoveryMaxResults") !== "",
    kind: isRoutineKind(kind) ? kind : null,
    status: isRoutineStatus(status) ? status : null,
    frequency: isRoutineFrequency(frequency) ? frequency : null,
    runAtMinutes: timeOfDay(formData, "runAt"),
    runAtWeekday: weekday(formData, "runAtWeekday"),
    runAtDay: wholeNumberInRange(formData, "runAtDay", 1, 31),
    // **What is read here is whether to send, and never where.** The recipient
    // is the worker's owner, looked up from the database when a run finishes —
    // there is no address field on either form, and adding one to the
    // submission would change nothing.
    emailNotificationsEnabled: checkbox(formData, "emailNotificationsEnabled"),
  };
}

/**
 * What the worker will actually be saved as, which is not always what was
 * submitted.
 *
 * A field the form did not send, or sent unreadably, falls back — to the
 * quietest option when hiring, and to the worker's existing value when
 * editing. **A rule about the saved worker has to read the saved values**, and
 * a rule reading `input.status` would miss the case where a submission that
 * omits it lands on an `active` worker and leaves it active.
 *
 * Passed in rather than worked out here because the two fallbacks differ, and
 * that difference is the one place the hire and edit actions are allowed to
 * disagree.
 */
export type WorkerFormContext = {
  status: RoutineStatus;
  frequency: RoutineFrequency;
};

/**
 * The fields every worker has, in the order they are asked for.
 *
 * **Not simply the keys of `workerFieldLimits`**, which now also holds the
 * address — and an address is a field one kind of worker has. Checking its
 * length here would mean a prompt worker could be rejected for something in a
 * box it was never shown.
 */
const sharedTextFields = ["name", "description", "prompt"] as const;

/** Records a length complaint, leaving any message the field already earned. */
function applyLengthLimit(
  errors: WorkerFieldErrors,
  field: WorkerFieldName,
  value: string,
  language: string,
): void {
  const limit = workerFieldLimits[field];
  if (value.length > limit) {
    // The number is grouped the way it always was: how a figure is written is
    // a formatting question, and this Sprint changes wording only.
    errors[field] = t(language, "worker.validation.tooLong", {
      label: t(language, fieldLabelKeys[field]),
      limit: limit.toLocaleString("en-US"),
    });
  }
}

/**
 * The single source of truth for what a valid worker looks like.
 *
 * Both actions call this and neither adds checks of its own, so a rule cannot
 * apply on creation and go missing on edit.
 *
 * Only the name is always required. Description may be blank, and so may
 * Prompt — except on the one combination below.
 *
 * **A worker AutoOps runs on its own has to have something to run.** An
 * `active` worker on a cadence is dispatched without anyone present: an empty
 * prompt there is not a blank field waiting to be filled in, it is a run that
 * fails every slot, for as long as the worker exists. Nothing downstream
 * stops it — the schedule advances whether the run worked or not, and a tick
 * whose workers all failed still answers `200`.
 *
 * **Everything else keeps its blank prompt**, and that is deliberate rather
 * than an oversight:
 *
 * - `draft` and `paused` are not dispatched, so naming a worker and filling it
 *   in later stays possible — which is what `draft` is for.
 * - `active` with `manual` frequency has no slot to be dispatched into
 *   (`nextRunAt` is null and the scheduler never selects it), so it cannot
 *   fail unattended either.
 *
 * A hand-started run of any of those can still meet an empty prompt and fail.
 * That is one failure, in front of the person who asked for it, with the
 * result in a toast — a different event from the same failure repeating on a
 * schedule with nobody watching.
 *
 * Blank means blank after trimming, which `readWorkerForm` has already done by
 * the time this runs — the same thing that makes a whitespace-only name count
 * as missing.
 */
export function validateWorkerForm(
  input: WorkerFormInput,
  context: WorkerFormContext,
  language: string = DEFAULT_LANGUAGE,
): WorkerFieldErrors {
  const errors: WorkerFieldErrors = {};

  if (!input.name) {
    errors.name = t(language, "worker.validation.nameRequired");
  }

  if (
    context.status === "active" &&
    context.frequency !== "manual" &&
    input.prompt === ""
  ) {
    errors.prompt = t(
      language,
      "worker.validation.promptRequiredForScheduled",
    );
  }

  for (const field of sharedTextFields) {
    // A field already rejected keeps its first message: "Name is required"
    // says more than a length complaint about an empty string ever could.
    if (!errors[field]) {
      applyLengthLimit(errors, field, input[field], language);
    }
  }

  return errors;
}

/**
 * The rules for a worker of a particular kind.
 *
 * **A layer over `validateWorkerForm` rather than a replacement for it.** Every
 * rule that applies to a worker still applies here — the shared one runs first
 * and its messages win — so a kind cannot become a way around a check.
 *
 * **The kind is a parameter, not something read out of the submission.** Only
 * one caller is entitled to take it from a form: hiring, where nothing else
 * could say. Editing takes it from the stored worker, because a submission
 * claiming a different one is either a stale form or an attempt to convert a
 * worker into something it is not, and both are answered by ignoring it.
 *
 * **A website worker's instructions are always required**, whatever its status
 * or cadence, and that is a stricter rule than the shared one deliberately. For
 * a prompt worker the prompt *is* the work, so a blank one on a draft is an
 * unfinished thought and harmless. For a website worker the prompt is what to
 * do about a change that has already been detected: without it, the worker
 * still fetches the page, still stores a baseline, and still notices when it
 * moves — and then has nothing to say about it. It fails at the end, having
 * done everything except the part anyone wanted.
 *
 * **The address is checked for presence and length only.** Whether it is a URL
 * AutoOps will fetch is `parseWatchUrl`'s question, and the actions ask it —
 * they need the parsed URL anyway, to store the canonical form and, when
 * editing, to tell a new address from the same one written differently. Asking
 * here as well would parse the same string twice and put the answer in two
 * places.
 */
export function validateWorkerFormForKind(
  input: WorkerFormInput,
  context: WorkerFormContext,
  kind: RoutineKind,
  language: string = DEFAULT_LANGUAGE,
): WorkerFieldErrors {
  const errors = validateWorkerForm(input, context, language);

  if (kind === "discovery") {
    return validateDiscoveryFields(input, errors, language);
  }

  if (kind !== "website") {
    return errors;
  }

  if (input.websiteUrl === "") {
    errors.websiteUrl = t(language, "worker.validation.websiteUrlRequired");
  } else {
    applyLengthLimit(errors, "websiteUrl", input.websiteUrl, language);
  }

  if (input.prompt === "" && !errors.prompt) {
    errors.prompt = t(language, "worker.validation.changePromptRequired");
  }

  return errors;
}

/**
 * What a discovery worker needs before it can be saved.
 *
 * **Three fields, each refused rather than defaulted.** A search nobody wrote
 * is not a search, a source this version does not know is one nothing can ask,
 * and a count outside the range is a number the form was supposed to stop. The
 * one thing that does default is an absent count — see the create action — and
 * that is the difference between "did not say" and "said something wrong".
 *
 * **The instruction is not required, unlike a website worker's.** A website
 * worker's prompt is what the model is told to do with a change it found, so
 * without one there is nothing to ask; a discovery worker's is optional colour
 * on a judgement the selection step makes with or without it. The general rule
 * from `validateWorkerForm` still applies — a scheduled active worker needs a
 * prompt — and it is applied there rather than restated here.
 *
 * **The bounds come from `lib/discovery/limits.ts`.** They were decided in
 * C2.19C and are referenced rather than repeated, so the form and the adapter
 * cannot disagree about what a run is allowed to ask for.
 */
function validateDiscoveryFields(
  input: WorkerFormInput,
  errors: WorkerFieldErrors,
  language: string,
): WorkerFieldErrors {
  if (input.discoverySource === "") {
    errors.discoverySource = t(
      language,
      "worker.validation.discoverySourceRequired",
    );
  } else if (!isDiscoverySourceKind(input.discoverySource)) {
    errors.discoverySource = t(
      language,
      "worker.validation.discoverySourceUnknown",
    );
  }

  if (input.discoveryQuery === "") {
    errors.discoveryQuery = t(
      language,
      "worker.validation.discoveryQueryRequired",
    );
  } else {
    // The shared length check, so a reader being told about a length is told it
    // in the same words wherever they are — and against the same constant the
    // adapter obeys.
    applyLengthLimit(errors, "discoveryQuery", input.discoveryQuery, language);
  }

  // **Null is only wrong when the form said something.** An absent field is
  // answered by the default; a value that could not be read as a whole number
  // in range arrives here as null too, and only `discoveryMaxResultsSubmitted`
  // tells the two apart. Refusing both would make the count mandatory; accepting
  // both would silently turn "fifty" into five.
  if (input.discoveryMaxResultsSubmitted && input.discoveryMaxResults === null) {
    errors.discoveryMaxResults = t(
      language,
      "worker.validation.discoveryMaxResultsRange",
      { limit: DISCOVERY_MAX_RESULTS_CEILING },
    );
  }

  return errors;
}

export function hasWorkerFormErrors(errors: WorkerFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * One line for the toast, which has room for a sentence rather than a list.
 *
 * The fields keep the detail; this only has to say that something is wrong.
 */
export function summarizeWorkerFormErrors(
  errors: WorkerFieldErrors,
  language: string = DEFAULT_LANGUAGE,
): string {
  const messages = Object.values(errors);

  return messages.length === 1
    ? messages[0]
    : t(language, "worker.validation.summary", { count: messages.length });
}
