/**
 * Why a page could not be fetched.
 *
 * **Deliberately not `ProviderErrorKind`.** That one names the ways one model
 * request can fail, and it is confined to `lib/ai/` for the same reason this is
 * confined here: a vocabulary that covers two unrelated boundaries stops
 * describing either. A rate limit and a blocked address have nothing to say to
 * each other.
 *
 * The values split where the answer differs — something the owner can fix,
 * something the site did, something AutoOps refused to do. `blocked-address` is
 * the one worth reading twice: it is not a failure to reach somewhere, it is a
 * refusal to try.
 *
 * **Nothing stores these yet.** They stay inside the fetch boundary until there
 * is a run to attach them to, which is the sprint after this one. Naming a
 * column for them now would fix a taxonomy before anything has used it.
 */
export type WatcherErrorKind =
  /** Not a URL, or a URL carrying something a watch target may not carry. */
  | "invalid-url"
  /** A URL, but not one this fetches — anything that is not `http` or `https`. */
  | "unsupported-scheme"
  /**
   * A supported scheme on a port this does not watch.
   *
   * Its own kind rather than `invalid-url` because the URL is perfectly valid
   * and nothing about it is a mistake: it is a policy that refused it, and a
   * message saying "that is not a valid URL" about `https://example.com:8443/`
   * would send whoever wrote it looking for a typo.
   */
  | "unsupported-port"
  /** The name resolved somewhere AutoOps will not connect to. Never attempted. */
  | "blocked-address"
  /** The name did not resolve at all. */
  | "dns-failure"
  /** Resolved, but the connection did not happen. */
  | "connect-failure"
  /** The whole call ran out of time, wherever it had got to. */
  | "timeout"
  /** The chain of redirects was longer than allowed, or went in a circle. */
  | "redirect-limit"
  /**
   * A secure address redirected to a plain one.
   *
   * Not `unsupported-scheme`: `http` is supported, and saying otherwise would
   * be false about the one case where somebody watches a plain-text site on
   * purpose. What is refused is the *downgrade* — a page asked for over TLS
   * arriving without it, because a redirect said so.
   */
  | "insecure-redirect"
  /** The site answered, and its answer was not a success. */
  | "http-error"
  /** The body was larger than may be read. */
  | "response-too-large"
  /** The body is not something this can read as text. */
  | "unsupported-content-type"
  /**
   * The page named an encoding this does not decode.
   *
   * A refusal rather than an attempt: the alternative is to decode it as
   * something else and store whatever comes out, which is a baseline made of
   * mistakes.
   */
  | "unsupported-charset"
  /**
   * The bytes are not valid in the encoding they were said to be in.
   *
   * **Never a page full of replacement characters.** Decoding leniently would
   * turn a broken response into a perfectly ordinary-looking snapshot that
   * happens to be wrong, and the next fetch would compare against it.
   */
  | "invalid-encoding"
  /**
   * The response contradicted itself about its own encoding.
   *
   * A byte order mark says one thing and the header says another, and there is
   * no reading of that where one of them is obviously right. Picking a side
   * silently is how a page ends up decoded wrong and stored anyway.
   */
  | "encoding-conflict"
  /**
   * The markup could not be turned into text at all.
   *
   * **Not "the HTML was invalid".** Broken markup is the ordinary case and the
   * parser recovers from it the way a browser would; this is for the parser
   * itself failing, which leaves nothing to compare and no baseline to keep.
   * Separate from `unsupported-content-type`, which is a refusal before any
   * parsing happens.
   */
  | "normalization-failed";

/**
 * A fetch failure, named.
 *
 * **This is where sockets, DNS records and status codes stop.** Whatever the
 * platform threw is kept as `cause` for the log, and what leaves the boundary
 * is an ordinary `Error` that also says which of the kinds above it was.
 *
 * The same shape as `ProviderError` and `RunPersistenceError` — a class and a
 * predicate, nothing else. It is not the start of a hierarchy.
 */
export class WatcherError extends Error {
  readonly kind: WatcherErrorKind;

  constructor(
    kind: WatcherErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "WatcherError";
    this.kind = kind;
  }
}

/** Whether a rejection came from the fetch boundary. */
export function isWatcherError(error: unknown): error is WatcherError {
  return error instanceof WatcherError;
}
