import { WatcherError } from "@/lib/watcher/errors";

/** The only two schemes a watch target may use. */
const SUPPORTED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Reads a string as a target this is willing to fetch.
 *
 * **It decides nothing about where the name points.** Every check here is about
 * the URL as written; whether it resolves somewhere AutoOps may connect to is a
 * separate question, asked after resolution, in `lib/watcher/dns.ts`. Keeping
 * the two apart is what stops this from looking like a safety check — a URL
 * that gets through here is *syntactically* acceptable and nothing more.
 *
 * What it refuses, and why:
 *
 * - **Anything that is not `http` or `https`.** `file:` reads the container's
 *   disk and `data:` is a body pretending to be a location. Naming the two that
 *   are allowed rather than the ones that are not means a scheme nobody has
 *   thought of is refused by default.
 * - **Credentials in the URL.** `https://user:pass@host/` sends nothing here —
 *   this never authenticates — so accepting one would silently drop half of
 *   what was written. It is also the oldest way of making a URL read as one
 *   host and resolve as another.
 *
 * The fragment is dropped because it is never sent: keeping it would leave the
 * returned URL describing a request that was not made.
 */
export function parseWatchUrl(raw: string): URL {
  const trimmed = raw.trim();

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (error) {
    throw new WatcherError("invalid-url", "That is not a valid URL.", {
      cause: error,
    });
  }

  if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
    throw new WatcherError(
      "unsupported-scheme",
      `Only http and https addresses can be watched, not ${url.protocol}`,
    );
  }

  if (url.username !== "" || url.password !== "") {
    throw new WatcherError(
      "invalid-url",
      "A watched address cannot carry a username or password.",
    );
  }

  if (url.hostname === "") {
    throw new WatcherError("invalid-url", "That URL has no host.");
  }

  // **The port a page is served on, and nothing else.** Refusing internal
  // addresses stops AutoOps reaching this deployment's own network; it does
  // nothing about somebody else's. Left open, a worker pointed at
  // `http://some-host:22/` asks a stranger's machine whether its SSH port
  // answers, once a day, from Railway's address — and the failure kinds are
  // distinct enough to read the answer off. That is a port scanner with a
  // schedule, and no page worth watching needs it.
  //
  // The check is the empty string because `URL` has already removed the port
  // when it is the scheme's own: `http://example.com:80/` and
  // `https://example.com:443/` both arrive here with none, and everything else
  // — including `http://example.com:443/` — keeps the one it was written with.
  if (url.port !== "") {
    throw new WatcherError(
      "unsupported-port",
      `AutoOps only watches pages on the standard ${url.protocol.slice(0, -1)} port, not port ${url.port}.`,
    );
  }

  url.hash = "";
  return url;
}

/**
 * The host without the brackets an IPv6 literal is written in.
 *
 * `URL` keeps them — `http://[::1]/` has a hostname of `[::1]` — and every
 * consumer here wants the address itself: the parser that classifies it, and
 * the socket that connects to it. The brackets belong to the URL syntax, not to
 * the address.
 */
export function hostAddress(url: URL): string {
  const { hostname } = url;

  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}
