import type { DiscoveryCandidate, DiscoveryQuery, DiscoverySourceKind } from "@/lib/discovery/types";

/**
 * Where asking somewhere outside Koqentra what exists stops.
 *
 * **One interface, and everything provider-shaped is behind it.** `lib/ai/` keeps
 * the same line for models and `lib/notify/email.ts` for sending: what leaves
 * here is a list of `DiscoveryCandidate` or a `DiscoveryProviderError` naming one
 * of a closed set of reasons — never a status code, never a response body, never
 * a URL, and never the key that was in it.
 *
 * **A provider retrieves and nothing else.** It does not know what this worker
 * has already chosen, it does not rank, it does not decide how many to keep, and
 * it writes nothing down. Those are four different decisions made by three other
 * modules, and a provider that made any of them would have to be re-made for the
 * second provider.
 *
 * **Nothing calls any of this yet.** `routineKinds` does not contain
 * `discovery`, so no worker can be saved as one and nothing reaches a provider.
 * This is the boundary being settled before execution depends on it.
 */

/**
 * Why a provider could not answer.
 *
 * **A closed set, and none of it comes from the provider.** Each value is a
 * decision this boundary made about what happened, which is what lets a failure
 * be written down without the log holding a request URL — and a discovery
 * request carries the API key in its query string, so a URL that travelled would
 * be a key that travelled.
 *
 * The same minimal shape as `EmailDeliveryFailure` and `WatcherErrorKind`, and
 * deliberately neither of them: a search that could not be made and a page that
 * could not be fetched have nothing to say to each other. **Coarse on purpose** —
 * a reason exists when it would lead somewhere different, not because HTTP
 * distinguishes it.
 */
export type DiscoveryProviderFailure =
  /** No key is configured, so no request was made. */
  | "not-configured"
  /** The call ran out of time, wherever it had got to. */
  | "timeout"
  /** The request never got an answer. */
  | "network"
  /** The provider answered, and its answer was not a success. Redirects land here too. */
  | "rejected"
  /** A success whose body is not what the API documents, or is too large to read. */
  | "unreadable";

/**
 * A search that did not happen, named.
 *
 * The same shape as `EmailDeliveryError` — one class, one predicate, no
 * hierarchy. **Whatever the platform threw is deliberately not kept**: a `cause`
 * here would travel to whichever log a caller writes, and an aborted `fetch`
 * carries the request it was aborting.
 */
export class DiscoveryProviderError extends Error {
  readonly reason: DiscoveryProviderFailure;

  constructor(reason: DiscoveryProviderFailure) {
    super(`Discovery provider could not answer: ${reason}.`);
    this.name = "DiscoveryProviderError";
    this.reason = reason;
  }
}

/** Whether a rejection came from this boundary. */
export function isDiscoveryProviderError(
  error: unknown,
): error is DiscoveryProviderError {
  return error instanceof DiscoveryProviderError;
}

/**
 * One source, asked a question.
 *
 * **`source` is on the instance rather than a parameter** so a caller holding a
 * provider cannot ask it for something it is not. The factory is what turns a
 * stored string into one of these — see `lib/discovery/factory.ts`.
 */
export interface DiscoveryProvider {
  readonly source: DiscoverySourceKind;
  /**
   * What exists, newest first, already normalised.
   *
   * Returns the candidates it could read. **An answer containing items this
   * version cannot make sense of is still an answer** — those are dropped by
   * `toDiscoveryCandidates`, because refusing twenty results over three
   * unreadable ones turns a good run into a failed one. An answer that could
   * not be read *at all* throws.
   */
  search(query: DiscoveryQuery): Promise<DiscoveryCandidate[]>;
}
