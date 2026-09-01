import Anthropic from "@anthropic-ai/sdk";
import { ProviderError, type ProviderErrorKind } from "@/lib/ai/provider";
import {
  InvalidWorkerDraftResponseError,
  readWorkerDraftToolResult,
  workerDraftToolNames,
  type WorkerDraftGenerator,
  type WorkerDraftRequest,
  type WorkerDraftResult,
} from "@/lib/ai/worker-draft";
import { workerFieldLimits } from "@/lib/worker-input";
import { routineFrequencies } from "@/types";

/**
 * The model that turns a request into a draft.
 *
 * **The same model the execution provider uses**, stated again rather than
 * shared: that constant belongs to a file about running workers, and importing
 * it here would tie the two choices together. They agree today because there is
 * one model worth using, not because one follows the other.
 */
const MODEL = "claude-opus-5";

/**
 * How long a person waits with a button pressed.
 *
 * **Deliberately not the execution timeouts.** A worker's run has ten minutes
 * because a generation can legitimately take that long and nobody is watching;
 * a website change has two, inside a scheduled tick. This one is bounded by
 * somebody looking at a form, and thirty seconds is already a long time to look
 * at a spinner. The values are near each other in kind and unrelated in
 * purpose — sharing one would mean tuning a page changed a worker.
 */
const TIMEOUT_MS = 30_000;

/**
 * A draft is a handful of short fields.
 *
 * Sixteen thousand is what a worker's *output* may need. A worker's *settings*
 * are a name, a sentence, and an instruction — and a limit this size is also
 * what makes a truncated answer detectable rather than expensive: see the
 * `max_tokens` check below.
 */
const MAX_TOKENS = 2_000;

/** No retries, for the reason the execution provider gives: nobody chose three. */
const MAX_RETRIES = 0;

/**
 * What the model is allowed to decide, and what it must not.
 *
 * **Every prohibition here has a structural counterpart**, and the structure is
 * what actually holds:
 *
 * - It may not write an address — the tools have no field for one.
 * - It may not choose a status, a timezone, or a schedule instant — `WorkerDraft`
 *   has no place to put them.
 * - It may not invent a kind — there are three tools and no fourth answer.
 *
 * The words below exist so the model produces a *useful* answer within those
 * bounds, not so that they are enforced. Anything that depended on this text
 * being obeyed would be a rule written in the one place it cannot be checked.
 */
const SYSTEM_INSTRUCTION = [
  "You turn a person's description of a job into settings for one Koqentra worker.",
  "Koqentra has exactly two kinds of worker.",
  "A prompt worker sends its instructions to an AI on a schedule; it cannot browse, search, read email, or reach anything outside the text it is given.",
  "A website worker checks one web page on a schedule and asks the AI about it only when the page has changed.",
  "Call create_prompt_worker_draft or create_website_worker_draft for a request one of those can do.",
  "Call unsupported_worker_request for anything else — email, calendar, chat, files, notifications, or any other source Koqentra cannot reach. Never describe such a request as a prompt worker.",
  "You have not read any web page. Never describe what a page contains, and never write instructions that assume you have seen it.",
  "Never write a web address. Addresses come from the person's own words and are given to you as a numbered list; if there is more than one, say which by its number.",
  "Set a time, a weekday, or a day of the month only when the person named one. Leave them out otherwise.",
  "Write the name and description in the language the person used.",
].join("\n");

/**
 * The fields both worker tools ask for.
 *
 * Written as JSON Schema because that is what the API takes. The limits are
 * described rather than enforced here — the check that matters happens on the
 * way back, in `readWorkerDraftToolResult`, because a schema is an instruction
 * to a model and not a promise from one.
 */
const draftProperties = {
  name: {
    type: "string",
    description: `A short name for the worker, at most ${workerFieldLimits.name} characters.`,
  },
  description: {
    type: "string",
    description: `One sentence saying what the worker is for, at most ${workerFieldLimits.description} characters. May be empty.`,
  },
  prompt: {
    type: "string",
    description: `What the AI should do. For a website worker, what it should do when the page has changed. At most ${workerFieldLimits.prompt} characters.`,
  },
  frequency: {
    type: "string",
    enum: [...routineFrequencies],
    description:
      "How often the worker runs. Use manual when the person did not ask for a schedule.",
  },
  runAtMinutes: {
    type: ["integer", "null"],
    description:
      "Time of day as minutes past midnight (540 is 09:00). Only when the person named a time.",
  },
  runAtWeekday: {
    type: ["integer", "null"],
    description:
      "Day of the week, 0 for Sunday to 6 for Saturday. Only for a weekly worker whose day the person named.",
  },
  runAtDay: {
    type: ["integer", "null"],
    description:
      "Day of the month, 1 to 31. Only for a monthly worker whose day the person named.",
  },
} as const;

const requiredDraftFields = ["name", "description", "prompt", "frequency"];

const tools: Anthropic.Messages.Tool[] = [
  {
    name: workerDraftToolNames.prompt,
    description:
      "Propose a worker that sends instructions to an AI on a schedule.",
    input_schema: {
      type: "object",
      properties: draftProperties,
      required: requiredDraftFields,
    },
  },
  {
    name: workerDraftToolNames.website,
    description:
      "Propose a worker that watches one web page and reports what changed.",
    input_schema: {
      type: "object",
      properties: {
        ...draftProperties,
        urlCandidateIndex: {
          type: ["integer", "null"],
          description:
            "Which address from the numbered list the worker should watch. Required only when the list holds more than one.",
        },
      },
      required: requiredDraftFields,
    },
  },
  {
    name: workerDraftToolNames.unsupported,
    description:
      "Report that Koqentra cannot do what was asked with either kind of worker.",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            "One sentence, addressed to the person, saying what Koqentra cannot do here.",
        },
      },
      required: ["reason"],
    },
  },
];

/**
 * Names the ways the provider itself can fail, coarsely and on purpose.
 *
 * **This is not `classify` from the execution provider, and does not try to
 * be.** That one splits failures eight ways so that a decision about retrying
 * can one day be made from run history — it reads statuses, and it lives beside
 * the calls it describes. Draft generation writes no history, retries nothing,
 * and reports to somebody standing at a form: what changes their next action is
 * "it took too long", "it could not be reached", or "it did not work".
 *
 * Copying the finer mapping here would put the same policy in two files, and
 * the copy would be the one that went stale.
 */
function classify(error: unknown): ProviderErrorKind {
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return "timeout";
  }

  if (error instanceof Anthropic.APIConnectionError) {
    return "unreachable";
  }

  return "unknown";
}

/**
 * Asks a model to describe the worker somebody just asked for.
 *
 * **Only reachable when a key is configured.** There is no stand-in: see
 * `createWorkerDraftGenerator`.
 */
export class ClaudeWorkerDraftGenerator implements WorkerDraftGenerator {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({
      apiKey,
      timeout: TIMEOUT_MS,
      maxRetries: MAX_RETRIES,
    });
  }

  async generate(request: WorkerDraftRequest): Promise<WorkerDraftResult> {
    let message: Anthropic.Messages.Message;

    try {
      message = await this.client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_INSTRUCTION,
        // **One tool call, and it must be one of these.** `any` requires a tool
        // rather than allowing prose, and disabling parallel use makes it
        // exactly one — so "answered in text" and "answered twice" are refusals
        // below rather than shapes this has to reconcile.
        tool_choice: { type: "any", disable_parallel_tool_use: true },
        tools,
        messages: [{ role: "user", content: buildUserMessage(request) }],
      });
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }

      throw new ProviderError(classify(error), error.message, { cause: error });
    }

    // **A truncated answer is not a short one.** Stopping at the token limit
    // leaves a tool input cut off mid-value, and a partial draft is exactly the
    // kind of plausible wrong answer this whole boundary exists to refuse.
    if (message.stop_reason === "max_tokens") {
      throw new InvalidWorkerDraftResponseError(
        "the model ran out of room before finishing its answer",
      );
    }

    const toolUses = message.content.filter((block) => block.type === "tool_use");

    if (toolUses.length === 0) {
      throw new InvalidWorkerDraftResponseError(
        "the model answered without proposing a worker",
      );
    }

    // Parallel use is disabled in the request, so more than one means the
    // request was not honoured — and picking one of two answers would be this
    // deciding what somebody asked for.
    if (toolUses.length > 1) {
      throw new InvalidWorkerDraftResponseError(
        "the model proposed more than one worker at once",
      );
    }

    return readWorkerDraftToolResult(
      toolUses[0].name,
      toolUses[0].input,
      request.urlCandidates,
    );
  }
}

/**
 * The request as the model sees it: what was asked, and which addresses were in
 * it.
 *
 * **The addresses are numbered because the answer is a number.** Handing them
 * over as a list the model chooses from — rather than asking it for an address
 * — is what makes an invented address unrepresentable rather than forbidden.
 */
function buildUserMessage({
  request,
  urlCandidates,
}: WorkerDraftRequest): string {
  const addresses =
    urlCandidates.length === 0
      ? "ADDRESSES FOUND IN THE REQUEST: none"
      : [
          "ADDRESSES FOUND IN THE REQUEST:",
          ...urlCandidates.map((url, index) => `${index}. ${url}`),
        ].join("\n");

  return `REQUEST:\n${request}\n\n${addresses}`;
}
