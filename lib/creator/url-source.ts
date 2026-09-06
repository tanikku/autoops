import "server-only";

import { creatorAnalysisLimits } from "@/lib/creator/analyzer";
import { decodeWebsiteContent } from "@/lib/watcher/decode";
import { isWatcherError, type WatcherErrorKind } from "@/lib/watcher/errors";
import { extractDocumentText } from "@/lib/watcher/extract";
import { type FetchDeps, fetchWatchedPage } from "@/lib/watcher/fetch";
import { normalizeWhitespace } from "@/lib/watcher/normalize";
import { parseWatchUrl } from "@/lib/watcher/url";
import { acquireWebsiteDomainThrottle } from "@/lib/website-throttle";

/**
 * Turning a public web page into something the Creator analyzer can read.
 *
 * **This is the only new thing C1.9A adds to the network.** Everything that
 * decides whether an address may be reached at all — the scheme, the port, the
 * addresses a name resolves to, what happens at each redirect, how long the
 * whole call has and how many bytes may arrive — is `lib/watcher`'s, unchanged
 * and uncopied. A second implementation of that policy is the shape this
 * mistake takes: it starts as "the Creator case is a bit different" and ends as
 * two sets of rules where only one gets the next fix.
 *
 * **It knows nothing about who is asking.** No session, no database, no
 * profile, no analyzer. What comes back is a URL and a string.
 *
 * **What comes back is untrusted.** It is somebody else's page, and it may
 * contain text shaped like an instruction. That is already answered where it
 * has to be — `lib/creator/claude-creator-analyzer.ts` sends every dynamic
 * value as JSON data under a static system instruction that says so — and
 * nothing here needs to sanitise prose to make that true.
 */

/**
 * Why a page could not be used, in the vocabulary a reader gets.
 *
 * **Deliberately coarser than `WatcherErrorKind`.** That vocabulary exists to
 * tell an operator what happened at the socket; this one exists to tell
 * somebody what to do next, and there is nothing different to do about a DNS
 * failure and a 503. Keeping them separate is also what stops a fetch-layer
 * message — which can name a host, a status or a charset — reaching a screen.
 */
export type CreatorUrlFailure =
  /** The address itself cannot be fetched: malformed, wrong scheme, a port. */
  | "invalid-url"
  /** A refusal rather than a failure — somewhere Koqentra will not go. */
  | "blocked"
  /** The page did not arrive. */
  | "unavailable"
  /** It arrived and could not be read as an HTML document. */
  | "unreadable"
  /** More than may be read, or more than may be analysed. */
  | "too-large"
  /** Read successfully, with no text in it. */
  | "empty";

/**
 * A page that cannot become a source, named by what a reader should do.
 *
 * **Nothing from the page or the fetch is in it.** No URL, no host, no status,
 * no charset, no cause: the `WatcherError` that prompted it carries all of
 * those and stops here. The same shape as every other boundary error in this
 * repository — one class, one predicate.
 */
export class CreatorUrlSourceError extends Error {
  readonly failure: CreatorUrlFailure;

  constructor(failure: CreatorUrlFailure) {
    super(`That page cannot be used as a source (${failure})`);
    this.name = "CreatorUrlSourceError";
    this.failure = failure;
  }
}

export function isCreatorUrlSourceError(
  error: unknown,
): error is CreatorUrlSourceError {
  return error instanceof CreatorUrlSourceError;
}

/** A page, and the address its body actually came from. */
export type CreatorUrlSource = {
  /**
   * The final URL, after any redirects.
   *
   * **Not the one somebody typed.** What gets analysed and stored has to be
   * where the text came from; recording the address that was asked for would
   * describe a page that may never have been read.
   */
  sourceUrl: string;
  /** The document's visible text, whitespace-normalised. */
  body: string;
};

/**
 * Which reader-facing failure a fetch-layer one becomes.
 *
 * Grouped by what somebody can do about it: fix the address, nothing (it is a
 * refusal), try again later, use a different page, or paste the text instead.
 */
const FAILURE_BY_KIND = {
  "invalid-url": "invalid-url",
  "unsupported-scheme": "invalid-url",
  "unsupported-port": "invalid-url",
  "blocked-address": "blocked",
  "insecure-redirect": "blocked",
  "dns-failure": "unavailable",
  "connect-failure": "unavailable",
  timeout: "unavailable",
  throttled: "unavailable",
  "redirect-limit": "unavailable",
  "http-error": "unavailable",
  "response-too-large": "too-large",
  "unsupported-content-type": "unreadable",
  "unsupported-charset": "unreadable",
  "invalid-encoding": "unreadable",
  "encoding-conflict": "unreadable",
  "normalization-failed": "unreadable",
} as const satisfies Record<WatcherErrorKind, CreatorUrlFailure>;

/**
 * Turns a fetch-layer rejection into a reader-facing one, or lets it through.
 *
 * **Only the kind is logged.** It is a closed vocabulary that names no host and
 * quotes no page; the `WatcherError`'s own message can name a media type, a
 * charset or a status, and the address is somebody's browsing.
 *
 * Anything that is not a `WatcherError` carries on out of here. It is a fault
 * on Koqentra's own side, and the caller already has a category for that.
 */
function asSourceFailure(error: unknown): unknown {
  if (!isWatcherError(error)) {
    return error;
  }

  console.error(`[creator] URL source failed: ${error.kind}`);

  return new CreatorUrlSourceError(FAILURE_BY_KIND[error.kind]);
}

/**
 * Whether an address could be fetched at all, without touching the network.
 *
 * **Cheap refusals stay cheap.** A typo, an `ftp://`, a port, or an address
 * carrying credentials can all be settled before an account row is created,
 * before an allowance moves, and before anybody's server is contacted — which
 * is the same ordering the text path already keeps.
 *
 * It is `parseWatchUrl` that decides, so this cannot drift from what the fetch
 * would have done.
 */
export function validateCreatorSourceUrl(rawUrl: string): void {
  if (rawUrl.trim() === "") {
    throw new CreatorUrlSourceError("invalid-url");
  }

  if (rawUrl.length > creatorAnalysisLimits.contentSourceUrl) {
    throw new CreatorUrlSourceError("invalid-url");
  }

  try {
    parseWatchUrl(rawUrl);
  } catch (error) {
    throw asSourceFailure(error);
  }
}

/**
 * Reads a public HTML page and returns its text.
 *
 * **The domain throttle is the platform's, not this feature's.** A Creator
 * analysis and a Website Worker pointed at the same host are two requests from
 * the same deployment, and politeness is a property of the host rather than of
 * whichever feature happened to ask. `fetchWatchedPage`'s default allows
 * everything and exists so the module can be tested without a database — it is
 * never what production runs.
 *
 * **Nothing is trimmed to fit.** A page longer than an analysis may carry is
 * refused rather than cut: the Creator contract is that the piece being judged
 * is the piece that was submitted, and a URL is not a reason to change that.
 */
export async function loadCreatorUrlSource(
  rawUrl: string,
  deps: FetchDeps = {},
): Promise<CreatorUrlSource> {
  validateCreatorSourceUrl(rawUrl);

  const { throttle = acquireWebsiteDomainThrottle, ...rest } = deps;

  let sourceUrl: string;
  let body: string;

  try {
    const page = await fetchWatchedPage(rawUrl, { ...rest, throttle });

    // The same three steps the Website Worker takes, minus the hash: a snapshot
    // is for noticing that a page changed, and this reads one page once.
    const decoded = decodeWebsiteContent(page.body, page.contentTypeHeader);

    sourceUrl = page.url;
    body = normalizeWhitespace(extractDocumentText(decoded.content));
  } catch (error) {
    throw asSourceFailure(error);
  }

  // **The address that has to be stored, measured against the same limit the
  // submitted one was.** A redirect chain can end somewhere longer than the
  // analyzer will accept, and silently shortening it would record a page nobody
  // fetched.
  if (sourceUrl.length > creatorAnalysisLimits.contentSourceUrl) {
    throw new CreatorUrlSourceError("invalid-url");
  }

  if (body === "") {
    throw new CreatorUrlSourceError("empty");
  }

  if (body.length > creatorAnalysisLimits.contentBody) {
    throw new CreatorUrlSourceError("too-large");
  }

  return { sourceUrl, body };
}
