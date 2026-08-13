import type { SupportedContentType } from "@/lib/watcher/body";
import {
  type AddressResolver,
  resolveSafeAddresses,
  systemResolver,
} from "@/lib/watcher/dns";
import { WatcherError } from "@/lib/watcher/errors";
import { FETCH_BUDGET_MS, MAX_REDIRECTS } from "@/lib/watcher/limits";
import { nodeTransport, type Transport } from "@/lib/watcher/transport";
import { hostAddress, parseWatchUrl } from "@/lib/watcher/url";

/** A page that was fetched, and where it was in the end. */
export type FetchedPage = {
  /** The address the body came from, which is not always the one asked for. */
  url: string;
  status: number;
  contentType: SupportedContentType;
  body: string;
  byteLength: number;
};

/**
 * The two things that reach outside the process, and the clock.
 *
 * Injectable so the policy below can be tested for what it does rather than for
 * what a network happened to do — and so that a test which forgets to supply
 * one fails loudly on a guarded global rather than quietly making a request.
 */
export type FetchDeps = {
  resolve?: AddressResolver;
  transport?: Transport;
  now?: () => number;
};

/**
 * Fetches a page a worker is watching, or says why it would not.
 *
 * **Nothing calls this yet.** It is the whole of what this sprint builds: a
 * primitive with its safety argument complete, sitting outside the execution
 * path until there is something to connect it to.
 *
 * The loop is the policy, and it is deliberately shaped so that no hop can skip
 * a check:
 *
 * ```
 * parse → resolve → verify every address → connect to those addresses
 *   ↑                                                  ↓
 *   └──────────────── redirect ─────────────────────────┘
 * ```
 *
 * **Every redirect goes back to the top.** Following one inside the transport
 * would be the same bug in a different place: the second request would be made
 * to a host nothing had checked, and the check that mattered would be the one
 * performed on the URL somebody typed. A redirect to `http://localhost/` fails
 * here exactly as typing it would.
 *
 * **The budget spans the whole call**, so what is handed to each hop is what is
 * left rather than a fresh allowance. A chain of slow redirects therefore costs
 * what one slow request costs, and the tick has a number it can rely on.
 *
 * What comes back is the *final* URL, not the one asked for. The two differ
 * whenever a redirect was followed, and the caller comparing pages across runs
 * needs to know which page it got.
 */
export async function fetchWatchedPage(
  rawUrl: string,
  deps: FetchDeps = {},
): Promise<FetchedPage> {
  const {
    resolve = systemResolver,
    transport = nodeTransport,
    now = Date.now,
  } = deps;

  const deadline = now() + FETCH_BUDGET_MS;
  let target = parseWatchUrl(rawUrl);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new WatcherError("timeout", "The page took too long to arrive.");
    }

    const addresses = await resolveSafeAddresses(hostAddress(target), resolve);
    const hop = await transport(target, addresses, remaining);

    if (hop.kind === "page") {
      return {
        url: target.toString(),
        status: hop.status,
        contentType: hop.contentType,
        body: hop.body,
        byteLength: hop.byteLength,
      };
    }

    target = nextTarget(hop.location, target);
  }

  throw new WatcherError(
    "redirect-limit",
    `That address redirected more than ${MAX_REDIRECTS} times.`,
  );
}

/**
 * Where a `Location` points, as a target this is willing to fetch.
 *
 * Resolved against the URL that produced it, because the header is allowed to
 * be relative — and then put through the same parsing as the original, which is
 * what refuses a redirect into `file:`, onto a port this does not watch, or
 * into a URL carrying credentials.
 *
 * **A secure page may not be redirected onto a plain one.** Watching an `http`
 * site is somebody's decision to make and they make it by writing `http`;
 * arriving there because a redirect said so is not that decision, and the
 * downgrade would be silent — the same worker, the same page, now fetched
 * where anyone on the path can read and change it. The other three directions
 * are allowed, including `http` to `https`, which is the ordinary case and an
 * improvement rather than a downgrade.
 *
 * Checked per hop rather than once at the end, so a chain that goes secure,
 * plain, secure again is refused at the plain step instead of being judged by
 * where it happened to stop.
 */
function nextTarget(location: string, from: URL): URL {
  let absolute: URL;

  try {
    absolute = new URL(location, from);
  } catch (error) {
    throw new WatcherError(
      "invalid-url",
      "That site redirected to something that is not a valid URL.",
      { cause: error },
    );
  }

  const target = parseWatchUrl(absolute.toString());

  if (from.protocol === "https:" && target.protocol === "http:") {
    throw new WatcherError(
      "insecure-redirect",
      "That site redirected from a secure address to a plain one.",
    );
  }

  return target;
}
