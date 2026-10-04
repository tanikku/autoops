/**
 * What the model decided about a change to a page that waits for something.
 *
 * **Exactly two things, and nothing else.** Whether the change is the one the
 * owner waits for, and what to say about it. A model that adds a key, wraps the
 * answer in prose or a code fence, or leaves the summary empty has not given an
 * answer this can stand behind, and the change is looked at again next time
 * rather than half-used now.
 *
 * Pure: the same text always reads the same way.
 */

export type WebsiteTargetDecision = {
  /** Whether this change is what the owner waits for. */
  readonly notify: boolean;
  /**
   * What to tell the owner when it is, or a short reason when it is not.
   * Trimmed, never empty.
   */
  readonly summary: string;
};

/**
 * An answer that could not be used.
 *
 * **Carries what was wrong, never what was said.** The answer is a model's
 * reading of somebody else's page; it does not belong in an error string that
 * may end up in a log.
 */
export class InvalidWebsiteTargetDecisionError extends Error {
  readonly detail: string;

  constructor(detail: string, options?: { cause?: unknown }) {
    super(`The target decision could not be used: ${detail}`, options);
    this.name = "InvalidWebsiteTargetDecisionError";
    this.detail = detail;
  }
}

export function isInvalidWebsiteTargetDecision(
  error: unknown,
): error is InvalidWebsiteTargetDecisionError {
  return error instanceof InvalidWebsiteTargetDecisionError;
}

const KEYS = ["notify", "summary"];

/**
 * Checks an already-parsed value against the decision's shape.
 *
 * Throws `InvalidWebsiteTargetDecisionError` for anything but an object with
 * exactly `notify` (a boolean) and `summary` (a string with something in it).
 */
export function validateWebsiteTargetDecision(value: unknown): WebsiteTargetDecision {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidWebsiteTargetDecisionError("the answer was not an object");
  }

  const keys = Object.keys(value);

  if (keys.some((key) => !KEYS.includes(key))) {
    throw new InvalidWebsiteTargetDecisionError("the answer has a key it should not");
  }

  const { notify, summary } = value as { notify?: unknown; summary?: unknown };

  if (typeof notify !== "boolean") {
    throw new InvalidWebsiteTargetDecisionError("the answer has no notify decision");
  }

  if (typeof summary !== "string") {
    throw new InvalidWebsiteTargetDecisionError("the answer has no summary");
  }

  const trimmed = summary.trim();

  if (trimmed === "") {
    throw new InvalidWebsiteTargetDecisionError("the answer's summary is empty");
  }

  return { notify, summary: trimmed };
}

/**
 * Reads the model's whole answer as the decision.
 *
 * **The whole answer is the JSON document.** A code fence, a sentence before
 * it or a note after it all make it something other than JSON, and it is
 * refused rather than dug out — a parser that went looking would be guessing
 * which part the model meant.
 */
export function parseWebsiteTargetDecision(text: string): WebsiteTargetDecision {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new InvalidWebsiteTargetDecisionError("the answer was not valid JSON", {
      cause: error,
    });
  }

  return validateWebsiteTargetDecision(parsed);
}
