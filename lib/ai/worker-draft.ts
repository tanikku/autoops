import { workerFieldLimits } from "@/lib/worker-input";
import {
  isRoutineFrequency,
  type RoutineFrequency,
  type RoutineKind,
} from "@/types";

/**
 * Turning a sentence into a worker somebody can look at before it exists.
 *
 * **This is configuration, not execution**, and the two are kept apart on
 * purpose. `AIProvider` sends a worker's prompt to a model and hands back what
 * came out; nothing about that request is inspected, because the answer *is*
 * the product. Here the answer is a set of form values, every one of which is a
 * claim about what the person asked for — so everything below exists to stop a
 * claim becoming a fact without a human in between.
 *
 * Three rules shape the whole file:
 *
 * - **A draft is a proposal for a form, never a write.** What is produced here
 *   goes into the fields somebody is already looking at, and reaches the
 *   database only through the same create action a hand-typed worker does.
 * - **The model classifies; it does not invent.** It may say "this is a website
 *   worker" and write a name for it. It may not produce an address, a status, a
 *   timezone, or a schedule instant — see `WorkerDraft` for what is missing and
 *   why.
 * - **Its output is `unknown` until proven otherwise.** A tool schema is an
 *   instruction to a model, not a guarantee from one: the SDK itself types a
 *   tool's input as `unknown`, which is the honest shape.
 */

/**
 * How much natural language one draft may be built from.
 *
 * Enough for a paragraph describing a job, and short enough that a single press
 * of a button cannot become an expensive request. It is a request limit, not a
 * field limit — nothing here is stored — so it is deliberately not one of
 * `workerFieldLimits`.
 */
export const MAX_WORKER_DRAFT_REQUEST_CHARS = 2_000;

/** The most addresses read out of one request. Past this, the ask is not a worker. */
const MAX_URL_CANDIDATES = 10;

/** What both kinds of worker are described by. */
type WorkerDraftBase = {
  name: string;
  description: string;
  prompt: string;
  frequency: RoutineFrequency;
  runAtMinutes: number | null;
  runAtWeekday: number | null;
  runAtDay: number | null;
};

export type PromptWorkerDraft = WorkerDraftBase & { kind: "prompt" };

export type WebsiteWorkerDraft = WorkerDraftBase & {
  kind: "website";
  /**
   * **Taken from the request, never written by the model.**
   *
   * A model asked for an address will produce one — plausible, well-formed, and
   * belonging to nobody. A worker pointed at it would fetch a stranger's site
   * on a schedule while its owner believed it was watching their own. So the
   * addresses are read out of what the person typed, and the model's only say
   * is which of them it meant. See `resolveUrlCandidate`.
   */
  websiteUrl: string;
};

/**
 * A worker as it would be filled into the form.
 *
 * **Closed over `RoutineKind`, and missing four things on purpose:**
 *
 * - `status` — the form asks for it, and starting a worker is a decision that
 *   belongs to the person reading the draft rather than to the draft.
 * - `timezone` — an account setting, not a worker's.
 * - `nextRunAt` — derived by `calculateNextRunAt` at creation. A second source
 *   for it would be a second schedule.
 * - a canonical URL — `parseWatchUrl` remains the one place an address is
 *   judged and normalised.
 */
export type WorkerDraft = PromptWorkerDraft | WebsiteWorkerDraft;

/**
 * What came of asking, in the terms the person asked in.
 *
 * **`unsupported` and `needs_input` are answers, not failures.** A request for
 * something AutoOps does not do yet is understood perfectly well — there is
 * simply no worker to propose — and a website worker whose request names no
 * address is one question away from being complete. Neither is an error, and
 * neither is a `RoutineKind`: putting them in the kind union would make every
 * reader of a worker's kind handle two values that can never be stored.
 */
export type WorkerDraftResult =
  | { status: "supported"; draft: WorkerDraft }
  | { status: "unsupported"; reason: string }
  | { status: "needs_input"; field: "websiteUrl"; message: string };

/** What the generator is given: the request, and the addresses found in it. */
export type WorkerDraftRequest = {
  /** The person's own words, trimmed. */
  request: string;
  /**
   * Addresses read out of `request`, in the order they appeared.
   *
   * Supplied by the caller rather than found by the model, which is the whole
   * of the defence described on `WebsiteWorkerDraft.websiteUrl`.
   */
  urlCandidates: string[];
};

/**
 * Produces a draft, or says why there is none.
 *
 * **Deliberately not a method on `AIProvider`.** That interface is what a
 * worker's execution runs through and is in production; this is a different
 * job with a different deadline, a different size of answer, and a different
 * meaning of failure. An optional method on the existing one would also bring
 * back the thing `AIProviderMode` was introduced to remove — callers testing
 * what an object happens to have rather than being handed one that can.
 *
 * There is no stand-in implementation, and that is the fail-closed part: an
 * account with no provider configured gets no generator at all, rather than a
 * generator that fabricates worker settings. See `createWorkerDraftGenerator`.
 */
export interface WorkerDraftGenerator {
  generate(request: WorkerDraftRequest): Promise<WorkerDraftResult>;
}

/**
 * The model answered, and the answer was not usable.
 *
 * **One class, no taxonomy** — the same shape as `ExecutionSuppressedError` and
 * `RunPersistenceError`. Every way of being unusable leads to the same place:
 * nothing is proposed, and the person tries again or fills the form in
 * themselves. Splitting "used no tool" from "used two" would name a difference
 * nobody acts on.
 *
 * Distinct from `ProviderError`, which means the provider never answered.
 */
export class InvalidWorkerDraftResponseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InvalidWorkerDraftResponseError";
  }
}

export function isInvalidWorkerDraftResponse(error: unknown): boolean {
  return error instanceof InvalidWorkerDraftResponseError;
}

/**
 * The three answers the model may give, as tool names.
 *
 * **Named rather than inferred**, because the same strings are written into the
 * request and read out of the response, and a mismatch between the two would
 * look exactly like a model that ignored its instructions.
 */
export const workerDraftToolNames = {
  prompt: "create_prompt_worker_draft",
  website: "create_website_worker_draft",
  unsupported: "unsupported_worker_request",
} as const;

export type WorkerDraftToolName =
  (typeof workerDraftToolNames)[keyof typeof workerDraftToolNames];

const toolKinds: Record<string, RoutineKind> = {
  [workerDraftToolNames.prompt]: "prompt",
  [workerDraftToolNames.website]: "website",
};

/**
 * Addresses written in a request, in the order they were written.
 *
 * **Syntax only, and no network.** What comes back is what looked like an
 * `http` or `https` address in somebody's sentence — not something checked,
 * resolved, or fetched. Whether an address may actually be watched stays
 * `parseWatchUrl`'s question, asked when the worker is created and again before
 * every run.
 *
 * Trailing punctuation is dropped because sentences end: `…/news.` and
 * `…/news、` both carry a character that belongs to the prose. Anything longer
 * than the field could hold is left out rather than proposed and then rejected
 * on save.
 */
export function extractUrlCandidates(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>"'`(){}[\]、。，）]+/gi) ?? [];
  const candidates: string[] = [];

  for (const raw of found) {
    const url = raw.replace(/[.,;:!?]+$/, "");

    if (url.length > workerFieldLimits.websiteUrl) {
      continue;
    }

    if (!candidates.includes(url)) {
      candidates.push(url);
    }

    if (candidates.length === MAX_URL_CANDIDATES) {
      break;
    }
  }

  return candidates;
}

/** A record, or nothing — the shape everything below narrows from. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function invalid(message: string): never {
  throw new InvalidWorkerDraftResponseError(message);
}

/**
 * A trimmed string within the limit the form would hold it to.
 *
 * The limits are `workerFieldLimits` rather than numbers of this file's own:
 * a draft that could not be saved is not a draft, and two sets of limits would
 * eventually disagree about which.
 */
function readText(
  input: Record<string, unknown>,
  field: string,
  limit: number,
  { required }: { required: boolean },
): string {
  const raw = input[field];

  if (raw === undefined || raw === null) {
    if (required) {
      invalid(`the model left ${field} out`);
    }
    return "";
  }

  if (typeof raw !== "string") {
    invalid(`the model answered with a non-string ${field}`);
  }

  const value = raw.trim();

  if (required && value === "") {
    invalid(`the model answered with an empty ${field}`);
  }

  if (value.length > limit) {
    invalid(`the model answered with a ${field} past its limit`);
  }

  return value;
}

/**
 * A whole number in range, or null.
 *
 * **Absent and null mean the same thing**, and both mean "the person did not
 * say". A model that omits a time has not failed; one that answers `9.5` or
 * `"09:00"` has, because the column holds minutes and nothing here is going to
 * guess what was meant.
 */
function readOptionalInteger(
  input: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): number | null {
  const raw = input[field];

  if (raw === undefined || raw === null) {
    return null;
  }

  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    invalid(`the model answered with a non-integer ${field}`);
  }

  if (raw < min || raw > max) {
    invalid(`the model answered with ${field} outside its range`);
  }

  return raw;
}

function readFrequency(input: Record<string, unknown>): RoutineFrequency {
  const raw = input.frequency;

  if (typeof raw !== "string" || !isRoutineFrequency(raw)) {
    invalid("the model answered with a frequency this does not recognise");
  }

  return raw;
}

/**
 * Which of the addresses in the request this worker is for.
 *
 * **The model chooses an index, never a string.** With one address there is
 * nothing to choose and its answer is ignored; with several it points at one;
 * with none there is no worker to propose yet. At no point does a URL travel
 * from the model into the draft, so "the model invented an address" is not a
 * case that has to be caught — it cannot be expressed.
 */
function resolveUrlCandidate(
  input: Record<string, unknown>,
  candidates: string[],
): string | null {
  if (candidates.length === 0) {
    return null;
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  const index = readOptionalInteger(
    input,
    "urlCandidateIndex",
    0,
    candidates.length - 1,
  );

  if (index === null) {
    invalid("the model did not say which address it meant");
  }

  return candidates[index];
}

function readDraftBase(input: Record<string, unknown>): WorkerDraftBase {
  return {
    name: readText(input, "name", workerFieldLimits.name, { required: true }),
    description: readText(input, "description", workerFieldLimits.description, {
      required: false,
    }),
    prompt: readText(input, "prompt", workerFieldLimits.prompt, {
      required: true,
    }),
    frequency: readFrequency(input),
    runAtMinutes: readOptionalInteger(input, "runAtMinutes", 0, 1_439),
    runAtWeekday: readOptionalInteger(input, "runAtWeekday", 0, 6),
    runAtDay: readOptionalInteger(input, "runAtDay", 1, 31),
  };
}

/**
 * Reads one tool call into a result, or refuses it.
 *
 * **The whole of the model's output passes through here**, which is why it
 * takes `unknown`: a tool's input arrives from the SDK typed exactly that way,
 * and pretending otherwise would move the guesswork rather than remove it.
 *
 * Keys nobody asked for are ignored rather than rejected. A draft is a set of
 * proposed form values; an extra one is a value no field reads, and refusing
 * the whole proposal over it would trade something usable for nothing.
 */
export function readWorkerDraftToolResult(
  toolName: string,
  toolInput: unknown,
  candidates: string[],
): WorkerDraftResult {
  const input = asRecord(toolInput);

  if (!input) {
    invalid("the model answered with something that is not an object");
  }

  if (toolName === workerDraftToolNames.unsupported) {
    // Held to the description limit: it is a sentence shown next to the
    // request, and there is no reason for it to be longer than the longest
    // sentence a worker is allowed.
    const reason = readText(input, "reason", workerFieldLimits.description, {
      required: false,
    });

    return {
      status: "unsupported",
      reason:
        reason === "" ? "Koqentra cannot do this kind of work yet." : reason,
    };
  }

  const kind = toolKinds[toolName];

  if (kind === undefined) {
    invalid("the model used a tool this does not offer");
  }

  if (kind === "prompt") {
    return { status: "supported", draft: { kind, ...readDraftBase(input) } };
  }

  // **Read before the base**, so a website request with no address is answered
  // as the question it is rather than as a draft that is missing its point.
  const websiteUrl = resolveUrlCandidate(input, candidates);

  if (websiteUrl === null) {
    return {
      status: "needs_input",
      field: "websiteUrl",
      message: "Add the address of the page you want Koqentra to watch.",
    };
  }

  return {
    status: "supported",
    draft: { kind, websiteUrl, ...readDraftBase(input) },
  };
}
