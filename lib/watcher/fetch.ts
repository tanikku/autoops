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
  /** What the fetch accepted the response as. */
  contentType: SupportedContentType;
  /**
   * The `Content-Type` header as it was sent, charset parameter included.
   *
   * The fetch does not act on the charset — it does not decode — but it is the
   * only place the header exists, so dropping it here would be dropping it
   * everywhere.
   */
  contentTypeHeader: string;
  /**
   * The body exactly as it arrived.
   *
   * **Bytes, not text.** What they say depends on an encoding this layer has
   * deliberately not looked at; `lib/watcher/decode.ts` resolves that and turns
   * them into a string. `Uint8Array` rather than `Buffer` because the stream
   * this was read from already speaks it, and a `Buffer` satisfies it anyway.
   */
  body: Uint8Array;
  byteLength: number;
};

/**
 * Whether a host may be fetched now, and how long until it may.
 *
 * **Declared here rather than imported**, so that nothing in `lib/watcher`
 * depends on the module that keeps the state — that one talks to the database,
 * and this layer deliberately does not. The implementation is handed in by the
 * caller (`lib/runs.ts`), exactly as the resolver and the transport are, and it
 * has to satisfy this shape rather than the other way round.
 */
export type DomainThrottle = (
  host: string,
  now: Date,
) => Promise<{ allowed: true } | { allowed: false; retryAfterMs: number }>;

/**
 * The three things that reach outside the process, and the clock.
 *
 * Injectable so the policy below can be tested for what it does rather than for
 * what a network happened to do — and so that a test which forgets to supply
 * one fails loudly on a guarded global rather than quietly making a request.
 *
 * **The default throttle allows everything**, which is what keeps this module
 * usable — and testable — without a database. Nothing in production calls it
 * that way: `executeWebsite` passes the real one.
 */
export type FetchDeps = {
  resolve?: AddressResolver;
  transport?: Transport;
  now?: () => number;
  throttle?: DomainThrottle;
  /** How waiting is done. Injectable so a test never waits in real time. */
  sleep?: (ms: number) => Promise<void>;
};

/** What a run records when a fetch gave way to another one of ours. */
const THROTTLED_MESSAGE =
  "This site was checked very recently, so Koqentra did not fetch it again yet.";

const allowAll: DomainThrottle = async () => ({ allowed: true });

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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
 * **Waiting for a host's turn is inside that budget too**, and deliberately: a
 * wait added outside it would lengthen every worker by as much as the chain
 * allows, and a tick works through workers one at a time. Keeping it inside
 * means the promise this function makes — twenty seconds, whatever happens —
 * is exactly the promise it made before there was a throttle.
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
    throttle = allowAll,
    sleep = realSleep,
  } = deps;

  const deadline = now() + FETCH_BUDGET_MS;
  let target = parseWatchUrl(rawUrl);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (deadline - now() <= 0) {
      throw new WatcherError("timeout", "The page took too long to arrive.");
    }

    // **Before the name is even resolved.** A host we are not going to ask
    // should not have its name looked up on our behalf either, and a redirect
    // arrives here as an ordinary hop — so the site at the end of a chain is
    // waited for exactly as the one at the start.
    await awaitDomainTurn(target, { deadline, now, sleep, throttle });

    // **Read again, because waiting spent some of it.** Handing the hop the
    // allowance measured before the wait would let one fetch overrun the
    // budget by however long it waited, which is the whole thing keeping the
    // wait inside the budget was for.
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
        contentTypeHeader: hop.contentTypeHeader,
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
 * Waits for this host's turn, or gives up on it.
 *
 * **The host is the name as the URL parser normalised it** — lowercased, and
 * punycoded if it was not ASCII. No scheme, no port and no path: what is being
 * spaced out is requests to a machine somebody else runs. `www.example.com` and
 * `news.example.com` are two hosts here, which under-counts a site served from
 * both; grouping them needs the Public Suffix List, and guessing at it makes
 * unrelated sites on a shared domain wait for each other, which is worse.
 *
 * **At most two attempts, and the second is not preceded by a second wait.**
 * One wait of the length the first answer asked for, one more attempt, and then
 * an answer either way — a loop that kept trying would have no stated bound and
 * would spend a budget that belongs to the fetch.
 *
 * **The wait is clamped by what is left of the budget**, so a busy host cannot
 * make a fetch take longer than a slow one would. A hop that runs out this way
 * fails as `throttled` rather than as `timeout`, because that is what happened:
 * nothing was ever asked of the site.
 */
async function awaitDomainTurn(
  target: URL,
  deps: {
    deadline: number;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    throttle: DomainThrottle;
  },
): Promise<void> {
  const { deadline, now, sleep, throttle } = deps;
  const host = target.hostname;

  const first = await throttle(host, new Date(now()));
  if (first.allowed) {
    return;
  }

  const waitMs = Math.min(first.retryAfterMs, deadline - now());
  if (waitMs > 0) {
    await sleep(waitMs);
  }

  const second = await throttle(host, new Date(now()));
  if (second.allowed) {
    return;
  }

  throw new WatcherError("throttled", THROTTLED_MESSAGE);
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
