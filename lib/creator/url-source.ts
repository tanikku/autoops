import "server-only";

import { type DefaultTreeAdapterTypes, parse, serializeOuter } from "parse5";
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
  /**
   * What the page calls itself, when it says anything usable.
   *
   * **Only a fallback.** A title somebody typed is what they meant to call the
   * piece and always wins; this is what stops a page analysed with the box left
   * empty from being filed as "Untitled" forever.
   *
   * Null whenever the document has no `<title>`, has an empty one, or has one
   * longer than an analysis may carry — see `extractCreatorPageTitle`.
   */
  pageTitle: string | null;
};

/**
 * What a document calls itself, or null.
 *
 * **`<title>` and nothing else.** `og:title`, `twitter:title`, `h1` and
 * schema.org are all somebody's guess at what an *article* is called, and
 * guessing that well is a different problem from knowing what a document is.
 * `<title>` is the one answer the document states about itself.
 *
 * **Parsed, never matched.** A regular expression over markup gets entities
 * wrong — `A &amp; B` is "A & B" — and gets nesting, attributes and malformed
 * tags wrong in ways that are hard to see and easy to ship. `parse5` is already
 * a dependency and already how this repository reads HTML.
 *
 * **Too long is dropped rather than cut.** The Creator contract refuses a title
 * past its limit rather than trimming one, and an automatic convenience is the
 * last place to start rewriting somebody's material. Refusing the whole
 * analysis over it would be worse still: the page is fine, and only this
 * optional extra is not.
 */
export function extractCreatorPageTitle(html: string): string | null {
  let document: DefaultTreeAdapterTypes.Document;

  try {
    document = parse(html);
  } catch {
    // The body already went through `extractDocumentText`, which raises on a
    // parser failure. Reaching here means something odd, and an optional title
    // is not worth failing an analysis for.
    return null;
  }

  const raw = findTitleText(document);

  if (raw === null) {
    return null;
  }

  const title = normalizeWhitespace(raw);

  if (title === "" || title.length > creatorAnalysisLimits.contentTitle) {
    return null;
  }

  return title;
}

type Parse5Node = DefaultTreeAdapterTypes.Node;

/**
 * The text of the first `<title>` in the document, wherever the parser put it.
 *
 * A walk rather than a path through `html > head > title`: the parser relocates
 * elements while recovering from broken markup, and a title that ends up
 * somewhere unexpected is still what the page calls itself.
 */
function findTitleText(node: Parse5Node): string | null {
  if (!("childNodes" in node)) {
    return null;
  }

  for (const child of node.childNodes) {
    if (child.nodeName === "title" && "childNodes" in child) {
      return child.childNodes
        .map((part) => ("value" in part ? part.value : ""))
        .join("");
    }

    const nested = findTitleText(child);

    if (nested !== null) {
      return nested;
    }
  }

  return null;
}

/**
 * The part of a page worth judging, when the page says which part that is.
 *
 * **The problem this solves was measured, not imagined.** A real article
 * analysed in Production arrived with "投稿 ログイン 会員登録" in front of it
 * and the site's footer behind it: navigation and chrome were being handed to
 * the model as though somebody had written them, and the excerpt on the inbox
 * opened with a sign-up prompt.
 *
 * **Semantic HTML only.** `<main>` and `<article>` are the two elements whose
 * whole purpose is to say "this is the content", stated by the page's own
 * author. Everything else that could be used here — a class name, an id, the
 * biggest node, the densest text, the fewest links, an `h1` — is Koqentra
 * guessing at what a page means, and a guess that is right most of the time
 * silently truncates somebody's writing the rest of the time. There is no
 * length threshold either: a short announcement is a legitimate source, and
 * "too short to be the article" is exactly the kind of rule that would drop it.
 *
 * **`<main>` first, and an `<article>` inside one never wins.** `<main>` is the
 * page saying where its primary content is; `<article>` says only that
 * something is self-contained, which a related-post card, a recommendation and
 * a sidebar entry all are. An earlier version of this preferred the article and
 * an audit found what that costs: a page whose only `<article>` sat in an
 * `<aside>` had its real content replaced by a related-post teaser.
 *
 * **Exactly one, or nothing.** Two eligible `<main>` elements is a page that
 * has not said which one matters; picking the first would be inventing an
 * answer. The search moves on — to `<article>`, and then to the whole document,
 * which is what every page got before this existed.
 *
 * **A quality improvement that cannot cost anything.** The full-document text
 * is produced first, by exactly the code that produced it before. Everything
 * below is an attempt to do better, and any way it fails — a parser refusing
 * the markup, a candidate that turns out empty — ends with that text being
 * returned. No page that could be read yesterday becomes unreadable today.
 */
export function extractCreatorSourceBody(html: string): string {
  // **The existing answer, computed first and on the shared path.** If this
  // throws, it is the same failure the caller has always handled — a fetch
  // boundary error that becomes `unreadable` — and it must not be swallowed by
  // the enhancement below.
  const fullBody = normalizeWhitespace(extractDocumentText(html));

  try {
    const document = parse(html);
    const body = findBody(document);

    if (body === null) {
      // Markup so unusual the parser produced no body. The document text is
      // still whatever it is, and inventing a container here would be worse.
      return fullBody;
    }

    // **`main` before `article`, and the order is the correction.** See the
    // note above: an article is self-contained, not primary.
    for (const tagName of ["main", "article"] as const) {
      const candidates = collectEligible(body, tagName);

      if (candidates.length !== 1) {
        continue;
      }

      const selected = extractCandidateText(candidates[0]);

      // **An empty container is not a selection.** A page with a `<main>`
      // holding only a decorative image has still said where its content is,
      // and it has said "nowhere" — so the search carries on rather than
      // handing the model nothing.
      if (selected !== "") {
        return selected;
      }
    }
  } catch {
    // **Nothing is logged, deliberately.** What could be said here is the
    // address or the markup, and both are somebody's reading. This path is a
    // missed improvement rather than a failure, and the answer below is the
    // one the product gave before the improvement existed.
  }

  return fullBody;
}

/**
 * What one candidate says, read by the same rules as a whole document.
 *
 * **Serialised and handed back to the shared extractor**, rather than walked
 * here. What counts as text inside an element — that a `script` is a program, a
 * `style` is presentation, an `svg` is a picture, that a `p` starts a new line
 * and an unknown element does not — is `lib/watcher/extract.ts`'s answer, and
 * it is the answer the Website Worker uses. A second copy of it living here
 * would drift from that one, and the drift would show up as two features
 * disagreeing about what a page says.
 *
 * **What serialising loses is why the eligibility check exists.** The fragment
 * handed over starts at the candidate, so nothing inside the shared extractor
 * can see that an ancestor was `hidden` or that the candidate sat in a
 * `<footer>` — that has to be settled before this is called.
 */
function extractCandidateText(element: Parse5Node): string {
  return normalizeWhitespace(extractDocumentText(serializeOuter(element)));
}

/**
 * Places a page's primary source cannot be.
 *
 * **Each of these says what its contents are *for*, and none of them is "this
 * is the piece".** A `<nav>` is a way around the site, an `<aside>` is
 * tangential by definition, a `<header>` and a `<footer>` are the frame around
 * the content rather than the content. The rest hold markup that is not being
 * shown at all: a `<template>` is waiting to be used, a `<noscript>` is for a
 * reader who will never see this page, an `<iframe>` is somebody else's page,
 * and the last four are programs and pictures.
 *
 * **This is a selection policy, not a second text extractor.** It answers one
 * question — may this element stand for the whole page? — and it never decides
 * what counts as text. That remains `lib/watcher/extract.ts`'s, uncopied.
 */
const INELIGIBLE_ANCESTORS = new Set([
  "nav",
  "aside",
  "footer",
  "header",
  "template",
  "noscript",
  "iframe",
  "script",
  "style",
  "svg",
  "canvas",
]);

/** Whether the markup says this element is not currently shown. */
function hasHiddenAttribute(node: Parse5Node): boolean {
  return "attrs" in node && node.attrs.some((attr) => attr.name === "hidden");
}

/**
 * The node above this one, or null.
 *
 * A `Document` has no parent and does not carry the property at all, so the
 * check is a narrowing rather than a cast — nothing here asserts a shape parse5
 * did not give it.
 */
function parentOf(node: Parse5Node): Parse5Node | null {
  return "parentNode" in node ? node.parentNode : null;
}

/**
 * Whether an element may stand for the whole page.
 *
 * **The candidate itself, and every ancestor above it.** An audit of the
 * previous version found both halves of this mattering in practice: an
 * `<article>` inside `<div hidden>` replaced the visible content of the page,
 * because serialising the article threw the `hidden` away before anything could
 * act on it, and an `<article>` inside an `<aside>` replaced it because nothing
 * looked at where the article was.
 *
 * **The two questions have different boundaries, deliberately.**
 *
 * *Where the candidate sits* is a question about content: a `<nav>` or a
 * `<footer>` is a context somebody put something in, and above `<body>` there
 * are no such contexts left — only the document itself. That check stops there.
 *
 * *Whether it is shown* does not stop anywhere. `hidden` on `<body>` or on
 * `<html>` hides everything beneath it, and the shared extractor honours that
 * by never descending; serialising a candidate out of one would resurrect text
 * the markup says is not being displayed. So the `hidden` check continues all
 * the way up. The `Document` at the top carries no attributes, so the walk ends
 * there on its own rather than by a special case.
 */
function isEligibleCandidate(candidate: Parse5Node, body: Parse5Node): boolean {
  if (hasHiddenAttribute(candidate)) {
    return false;
  }

  let ancestor = parentOf(candidate);
  let reachedBody = false;

  while (ancestor !== null) {
    if (hasHiddenAttribute(ancestor)) {
      return false;
    }

    if (ancestor === body) {
      reachedBody = true;
    } else if (!reachedBody && INELIGIBLE_ANCESTORS.has(ancestor.nodeName)) {
      return false;
    }

    ancestor = parentOf(ancestor);
  }

  // Never reaching `body` means the candidate is not under it — a detached or
  // relocated subtree — and the page did not put it in its content.
  return reachedBody;
}

/**
 * Every descendant of `body` with the given tag name that may stand for the
 * page.
 *
 * **Named elements only — no attributes are read except `hidden`.** A `class`,
 * an `id` or a `role` is a convention rather than a statement, and reading one
 * would be the first heuristic; `hidden` is different because it is the markup
 * saying the element is not being shown.
 *
 * **Ineligible candidates do not count towards the cardinality either.** A page
 * with one real `<article>` and one in its footer has said where its content
 * is exactly once, and treating that as ambiguous would throw away the answer
 * it gave.
 */
function collectEligible(
  body: Parse5Node,
  tagName: string,
  node: Parse5Node = body,
  found: Parse5Node[] = [],
): Parse5Node[] {
  if (!("childNodes" in node)) {
    return found;
  }

  for (const child of node.childNodes) {
    if (child.nodeName === tagName && isEligibleCandidate(child, body)) {
      found.push(child);
    }

    collectEligible(body, tagName, child, found);
  }

  return found;
}

/** The document's `body`, or null when the markup produced none. */
function findBody(node: Parse5Node): Parse5Node | null {
  if (!("childNodes" in node)) {
    return null;
  }

  for (const child of node.childNodes) {
    if (child.nodeName === "body") {
      return child;
    }

    const nested = findBody(child);

    if (nested !== null) {
      return nested;
    }
  }

  return null;
}

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
  let pageTitle: string | null;

  try {
    const page = await fetchWatchedPage(rawUrl, { ...rest, throttle });

    // The same three steps the Website Worker takes, minus the hash: a snapshot
    // is for noticing that a page changed, and this reads one page once.
    const decoded = decodeWebsiteContent(page.body, page.contentTypeHeader);

    sourceUrl = page.url;
    // **The part the page says is the content, where it says so.** A document
    // that names neither an `<article>` nor a `<main>` gets exactly the text it
    // got before this existed — see `extractCreatorSourceBody`.
    body = extractCreatorSourceBody(decoded.content);
    // **Read from the same markup, and kept separate from it.** The title is
    // already part of the body — `extractDocumentText` takes it out of `head` —
    // and that is left exactly as it was: what the analyzer is given to judge
    // did not change in this checkpoint.
    pageTitle = extractCreatorPageTitle(decoded.content);
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

  return { sourceUrl, body, pageTitle };
}
