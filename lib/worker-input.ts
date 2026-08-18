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
} as const;

export type WorkerFieldName = keyof typeof workerFieldLimits;

/** Field-level messages, keyed by field. Empty means the input is acceptable. */
export type WorkerFieldErrors = Partial<Record<WorkerFieldName, string>>;

const fieldLabels: Record<WorkerFieldName, string> = {
  name: "Name",
  description: "Description",
  prompt: "Prompt",
  websiteUrl: "Website address",
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
};

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "").trim();
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
    // **A URL only exists on a submission that says it is watching a page.**
    // The create form hides the field when the other kind is chosen, but a
    // hidden field is a UI state rather than a guarantee — the value can still
    // arrive, from a stale form, a resubmission, or by hand. Dropping it here
    // means every path downstream reads `""` for a prompt worker without
    // having to remember to ask, which is what keeps a prompt worker from
    // acquiring a page to watch.
    websiteUrl: kind === "website" ? text(formData, "websiteUrl") : "",
    kind: isRoutineKind(kind) ? kind : null,
    status: isRoutineStatus(status) ? status : null,
    frequency: isRoutineFrequency(frequency) ? frequency : null,
    runAtMinutes: timeOfDay(formData, "runAt"),
    runAtWeekday: weekday(formData, "runAtWeekday"),
    runAtDay: wholeNumberInRange(formData, "runAtDay", 1, 31),
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
): WorkerFieldErrors {
  const errors: WorkerFieldErrors = {};

  if (!input.name) {
    errors.name = "Name is required.";
  }

  if (
    context.status === "active" &&
    context.frequency !== "manual" &&
    input.prompt === ""
  ) {
    errors.prompt = "Prompt is required for scheduled active workers.";
  }

  for (const field of Object.keys(workerFieldLimits) as WorkerFieldName[]) {
    // A field already rejected keeps its first message: "Name is required"
    // says more than a length complaint about an empty string ever could.
    if (errors[field]) {
      continue;
    }

    const limit = workerFieldLimits[field];
    if (input[field].length > limit) {
      errors[field] =
        `${fieldLabels[field]} must be ${limit.toLocaleString("en-US")} characters or fewer.`;
    }
  }

  return errors;
}

/**
 * The rules for hiring a worker, which depend on what it is being hired to do.
 *
 * **A layer over `validateWorkerForm` rather than a replacement for it.** Every
 * rule that applies to a worker still applies here — the shared one runs first
 * and its messages win — so a kind cannot become a way around a check. What is
 * added is only what a website worker needs and a prompt worker has no field
 * for, which is why the edit action goes on calling the shared one and is
 * unaffected by any of this.
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
 * AutoOps will fetch is `parseWatchUrl`'s question, and the create action asks
 * it — it needs the parsed URL anyway, to store the canonical form. Asking here
 * as well would parse the same string twice and put the answer in two places.
 */
export function validateCreateWorkerForm(
  input: WorkerFormInput,
  context: WorkerFormContext,
): WorkerFieldErrors {
  const errors = validateWorkerForm(input, context);

  if (input.kind !== "website") {
    return errors;
  }

  if (input.websiteUrl === "" && !errors.websiteUrl) {
    errors.websiteUrl = "Website address is required.";
  }

  if (input.prompt === "" && !errors.prompt) {
    errors.prompt = "Tell the worker what to do when the page changes.";
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
export function summarizeWorkerFormErrors(errors: WorkerFieldErrors): string {
  const messages = Object.values(errors);

  return messages.length === 1
    ? messages[0]
    : `${messages.length} fields need attention.`;
}
