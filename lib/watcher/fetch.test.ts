import httpModule from "node:http";
import httpsModule from "node:https";
import { isIP } from "node:net";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressResolver } from "@/lib/watcher/dns";
import { isWatcherError, type WatcherError } from "@/lib/watcher/errors";
import { fetchWatchedPage } from "@/lib/watcher/fetch";
import { FETCH_BUDGET_MS, MAX_REDIRECTS } from "@/lib/watcher/limits";
import type { Hop, Transport } from "@/lib/watcher/transport";

/**
 * **A wall, not a stub.** Every test here injects its own transport and
 * resolver, and this catches the one that forgets: without it a missing
 * argument would open a real socket to whatever hostname the test made up.
 * Sprint 40 learned this the expensive way, in a file that reached a live API
 * after a spy was restored.
 */
const realRequest = { http: httpModule.request, https: httpsModule.request };

httpModule.request = (() => {
  throw new Error("no network in tests");
}) as typeof httpModule.request;

httpsModule.request = (() => {
  throw new Error("no network in tests");
}) as typeof httpsModule.request;

afterAll(() => {
  httpModule.request = realRequest.http;
  httpsModule.request = realRequest.https;
});

const PUBLIC_ADDRESS = "93.184.216.34";

/**
 * Every name is public unless the test says otherwise.
 *
 * **An address resolves to itself**, the same as the real resolver does — a URL
 * written as an IP never reaches a name server. Answering those with a public
 * address instead would let a target like `http://169.254.169.254/` through a
 * test that is supposed to prove it cannot.
 */
function resolverWith(overrides: Record<string, string[]> = {}): AddressResolver {
  return vi.fn(async (hostname: string) => {
    if (isIP(hostname) !== 0) {
      return [hostname];
    }

    return overrides[hostname] ?? [PUBLIC_ADDRESS];
  });
}

/** A transport that reads from a script, one hop per call. */
function transportOf(...hops: Hop[]): Transport {
  const script = [...hops];
  return vi.fn(async () => {
    const hop = script.shift();
    if (hop === undefined) {
      throw new Error("the transport was called more times than scripted");
    }
    return hop;
  });
}

const PAGE_BYTES = Buffer.from("<html>hi</html>", "utf-8");

const page: Hop = {
  kind: "page",
  status: 200,
  contentType: "text/html",
  contentTypeHeader: "text/html; charset=utf-8",
  body: PAGE_BYTES,
  byteLength: PAGE_BYTES.byteLength,
};

function redirectTo(location: string, status = 302): Hop {
  return { kind: "redirect", status, location };
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return isWatcherError(error)
      ? (error as WatcherError).kind
      : `not-a-watcher-error: ${String(error)}`;
  }

  return "fetched";
}

let clock: number;

beforeEach(() => {
  clock = 0;
});

/** A clock that does not move unless a test moves it. */
const now = () => clock;

/**
 * A throttle that answers from a script, and remembers what it was asked.
 *
 * Every entry is one call: `true` lets the hop through, a number refuses it and
 * asks for that many milliseconds. Anything past the end of the script allows,
 * so a test only writes down the answers it cares about.
 */
function throttleOf(...answers: (true | number)[]) {
  const script = [...answers];
  const hosts: string[] = [];

  const throttle = vi.fn(async (host: string) => {
    hosts.push(host);
    const answer = script.shift();
    return answer === undefined || answer === true
      ? ({ allowed: true } as const)
      : ({ allowed: false, retryAfterMs: answer } as const);
  });

  return { throttle, hosts };
}

/** A sleep that moves the fake clock instead of waiting. */
function fakeSleep() {
  const waits: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    waits.push(ms);
    clock += ms;
  });
  return { sleep, waits };
}

/**
 * Spacing out how often one website is asked for a page.
 *
 * **The politeness is ours, and so is the waiting.** The module that remembers
 * when a host was last fetched only answers questions — whether now is a turn,
 * and how long until the next one. Deciding that waiting is worth it needs a
 * budget, and this is the only layer that has one.
 *
 * **Every hop asks, including a redirect's.** From the site's point of view a
 * request that arrived because something else pointed at it is still a request.
 */
describe("waiting for a host's turn", () => {
  it("resolves and connects once the turn is granted", async () => {
    const resolve = resolverWith();
    const transport = transportOf(page);
    const { throttle, hosts } = throttleOf(true);

    await fetchWatchedPage("https://example.com/", {
      resolve,
      transport,
      now,
      throttle,
    });

    expect(hosts).toEqual(["example.com"]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("asks about the host alone — no scheme, port or path", async () => {
    const { throttle, hosts } = throttleOf(true);

    await fetchWatchedPage("https://EXAMPLE.com/news?q=1", {
      resolve: resolverWith(),
      transport: transportOf(page),
      now,
      throttle,
    });

    // Lowercased by `URL`, and nothing else carried along.
    expect(hosts).toEqual(["example.com"]);
  });

  it("waits exactly as long as it was asked to, then goes ahead", async () => {
    const { throttle } = throttleOf(4_000, true);
    const { sleep, waits } = fakeSleep();
    const transport = transportOf(page);

    const result = await fetchWatchedPage("https://example.com/", {
      resolve: resolverWith(),
      transport,
      now,
      throttle,
      sleep,
    });

    expect(waits).toEqual([4_000]);
    expect(throttle).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(200);
  });

  it("gives up after one more attempt rather than waiting again", async () => {
    const { throttle } = throttleOf(4_000, 4_000);
    const { sleep, waits } = fakeSleep();
    const resolve = resolverWith();
    const transport = transportOf(page);

    const kind = await kindOf(
      fetchWatchedPage("https://example.com/", {
        resolve,
        transport,
        now,
        throttle,
        sleep,
      }),
    );

    expect(kind).toBe("throttled");
    // One wait, two attempts, and nothing asked of the site at all.
    expect(waits).toHaveLength(1);
    expect(throttle).toHaveBeenCalledTimes(2);
    expect(resolve).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("never waits longer than the fetch has left", async () => {
    const { throttle } = throttleOf(FETCH_BUDGET_MS * 2, FETCH_BUDGET_MS);
    const { sleep, waits } = fakeSleep();

    const kind = await kindOf(
      fetchWatchedPage("https://example.com/", {
        resolve: resolverWith(),
        transport: transportOf(page),
        now,
        throttle,
        sleep,
      }),
    );

    // The wait is clamped to the budget, and running out that way is
    // `throttled` rather than `timeout`: nothing was ever asked of the site.
    expect(waits).toEqual([FETCH_BUDGET_MS]);
    expect(kind).toBe("throttled");
  });

  /**
   * **The wait comes out of the same twenty seconds a slow site would spend.**
   * A tick works through workers one at a time, so a wait added outside the
   * budget would lengthen every worker behind this one.
   */
  it("spends the fetch budget rather than adding to it", async () => {
    const { throttle } = throttleOf(15_000, true);
    const { sleep } = fakeSleep();
    const transport = vi.fn(async (_target: URL, _addresses: string[], timeoutMs: number) => {
      expect(timeoutMs).toBe(FETCH_BUDGET_MS - 15_000);
      return page;
    });

    await fetchWatchedPage("https://example.com/", {
      resolve: resolverWith(),
      transport,
      now,
      throttle,
      sleep,
    });

    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("asks separately for each host in a redirect chain", async () => {
    const { throttle, hosts } = throttleOf(true, true);

    await fetchWatchedPage("https://example.com/", {
      resolve: resolverWith(),
      transport: transportOf(redirectTo("https://other.example.org/"), page),
      now,
      throttle,
    });

    expect(hosts).toEqual(["example.com", "other.example.org"]);
  });

  it("waits for a redirect's host too", async () => {
    const { throttle } = throttleOf(true, 3_000, true);
    const { sleep, waits } = fakeSleep();
    const transport = transportOf(redirectTo("https://other.example.org/"), page);

    const result = await fetchWatchedPage("https://example.com/", {
      resolve: resolverWith(),
      transport,
      now,
      throttle,
      sleep,
    });

    expect(waits).toEqual([3_000]);
    expect(result.url).toBe("https://other.example.org/");
  });

  it("refuses a redirect's host the same way it refuses the first", async () => {
    const { throttle } = throttleOf(true, 3_000, 3_000);
    const { sleep } = fakeSleep();
    const transport = transportOf(redirectTo("https://other.example.org/"));

    const kind = await kindOf(
      fetchWatchedPage("https://example.com/", {
        resolve: resolverWith(),
        transport,
        now,
        throttle,
        sleep,
      }),
    );

    expect(kind).toBe("throttled");
    // The first hop happened; the second was never asked for.
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("lets an unrelated host through while another waits", async () => {
    const { throttle, hosts } = throttleOf(true, true);

    await fetchWatchedPage("https://other.example.org/", {
      resolve: resolverWith(),
      transport: transportOf(page),
      now,
      throttle,
    });

    expect(hosts).toEqual(["other.example.org"]);
  });

  /** Nothing in this module reaches a database, and nothing here waits for real. */
  it("allows everything when no throttle is supplied", async () => {
    const transport = transportOf(page);

    const result = await fetchWatchedPage("https://example.com/", {
      resolve: resolverWith(),
      transport,
      now,
    });

    expect(result.status).toBe(200);
  });
});

describe("fetching a page", () => {
  it("returns what the transport read", async () => {
    const result = await fetchWatchedPage("https://example.com/", {
      resolve: resolverWith(),
      transport: transportOf(page),
      now,
    });

    expect(result).toEqual({
      url: "https://example.com/",
      status: 200,
      contentType: "text/html",
      contentTypeHeader: "text/html; charset=utf-8",
      body: PAGE_BYTES,
      byteLength: PAGE_BYTES.byteLength,
    });
  });

  /**
   * The fetch carries bytes and the header that says what they mean, and does
   * nothing with either. Decoding is `lib/watcher/decode.ts`'s job precisely
   * because it needs both, and this layer has deliberately not looked.
   */
  it("passes the body through as bytes, undecoded", async () => {
    const result = await fetchWatchedPage("https://example.com/", {
      resolve: resolverWith(),
      transport: transportOf(page),
      now,
    });

    expect(result.body).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(result.body).toString("utf-8")).toBe("<html>hi</html>");
  });

  it("hands the transport the addresses that were verified", async () => {
    const transport = transportOf(page);

    await fetchWatchedPage("https://example.com/", {
      resolve: resolverWith({ "example.com": [PUBLIC_ADDRESS, "8.8.8.8"] }),
      transport,
      now,
    });

    expect(transport).toHaveBeenCalledWith(
      expect.any(URL),
      [PUBLIC_ADDRESS, "8.8.8.8"],
      FETCH_BUDGET_MS,
    );
  });

  it("refuses a target it will not parse without asking anything to resolve it", async () => {
    const resolve = resolverWith();

    expect(
      await kindOf(
        fetchWatchedPage("file:///etc/passwd", {
          resolve,
          transport: transportOf(),
          now,
        }),
      ),
    ).toBe("unsupported-scheme");

    expect(resolve).not.toHaveBeenCalled();
  });

  it("refuses a target whose name resolves somewhere private, without connecting", async () => {
    const transport = transportOf(page);

    expect(
      await kindOf(
        fetchWatchedPage("http://localhost/", {
          resolve: resolverWith({ localhost: ["127.0.0.1"] }),
          transport,
          now,
        }),
      ),
    ).toBe("blocked-address");

    expect(transport).not.toHaveBeenCalled();
  });
});

/**
 * **The reason redirects are handled here rather than in the transport.** Each
 * hop goes back through parsing, resolution and the address check, so the
 * second request is verified as thoroughly as the first. A transport that
 * followed redirects itself would make the checks apply only to the URL
 * somebody typed — which is the URL an attacker is happy to make look harmless.
 */
describe("following a redirect", () => {
  it("follows one to another public page and reports where it ended", async () => {
    const result = await fetchWatchedPage("https://example.com/", {
      resolve: resolverWith(),
      transport: transportOf(redirectTo("https://elsewhere.example/final"), page),
      now,
    });

    expect(result.url).toBe("https://elsewhere.example/final");
  });

  it("resolves the redirect against the URL that produced it", async () => {
    const transport = transportOf(redirectTo("/moved"), page);

    const result = await fetchWatchedPage("https://example.com/start", {
      resolve: resolverWith(),
      transport,
      now,
    });

    expect(result.url).toBe("https://example.com/moved");
  });

  it("checks the address of every hop, not only the first", async () => {
    const resolve = resolverWith({ "internal.example": ["10.0.0.5"] });

    expect(
      await kindOf(
        fetchWatchedPage("https://example.com/", {
          resolve,
          transport: transportOf(redirectTo("https://internal.example/")),
          now,
        }),
      ),
    ).toBe("blocked-address");
  });

  it.each([
    ["http://localhost/", "blocked-address", { localhost: ["127.0.0.1"] }],
    ["http://169.254.169.254/", "blocked-address", {}],
    ["http://[::1]/", "blocked-address", {}],
    ["file:///etc/passwd", "unsupported-scheme", {}],
    ["data:text/html,x", "unsupported-scheme", {}],
    ["https://user:pass@example.com/", "invalid-url", {}],
    // **Started from `http`** so that the address checks are what refuse these.
    // From an `https` page the downgrade rule would fire first and these would
    // pass for a reason that says nothing about where they point.
  ])("refuses a redirect to %s as %s", async (location, kind, overrides) => {
    expect(
      await kindOf(
        fetchWatchedPage("http://example.com/", {
          resolve: resolverWith(overrides as Record<string, string[]>),
          transport: transportOf(redirectTo(location)),
          now,
        }),
      ),
    ).toBe(kind);
  });

  /**
   * **Three of the four directions are fine; the fourth is a downgrade.**
   * Watching a plain-text site is a decision somebody makes by writing `http`.
   * Ending up there because a redirect said so is not that decision, and it
   * happens without anything to show for it.
   */
  it.each([
    ["http://example.com/", "http://elsewhere.example/", "fetched"],
    ["http://example.com/", "https://elsewhere.example/", "fetched"],
    ["https://example.com/", "https://elsewhere.example/", "fetched"],
    ["https://example.com/", "http://elsewhere.example/", "insecure-redirect"],
  ])("%s redirected to %s is %s", async (from, to, expected) => {
    expect(
      await kindOf(
        fetchWatchedPage(from, {
          resolve: resolverWith(),
          transport: transportOf(redirectTo(to), page),
          now,
        }),
      ),
    ).toBe(expected);
  });

  it("keeps the scheme when the redirect is relative", async () => {
    const result = await fetchWatchedPage("https://example.com/start", {
      resolve: resolverWith(),
      transport: transportOf(redirectTo("/moved"), page),
      now,
    });

    expect(result.url).toBe("https://example.com/moved");
  });

  it("refuses a downgrade partway along a chain, not only at the end", async () => {
    expect(
      await kindOf(
        fetchWatchedPage("https://example.com/", {
          resolve: resolverWith(),
          transport: transportOf(
            redirectTo("https://second.example/"),
            redirectTo("http://third.example/"),
            page,
          ),
          now,
        }),
      ),
    ).toBe("insecure-redirect");
  });

  it.each([
    "https://elsewhere.example:8443/",
    "https://elsewhere.example:444/",
    "http://elsewhere.example:8080/",
  ])("refuses a redirect onto %s", async (location) => {
    expect(
      await kindOf(
        fetchWatchedPage("https://example.com/", {
          resolve: resolverWith(),
          transport: transportOf(redirectTo(location)),
          now,
        }),
      ),
    ).toBe("unsupported-port");
  });

  it("gives up on a chain longer than the limit", async () => {
    const hops = Array.from({ length: MAX_REDIRECTS + 1 }, (_, index) =>
      redirectTo(`https://example.com/hop-${index}`),
    );
    const transport = transportOf(...hops);

    expect(
      await kindOf(
        fetchWatchedPage("https://example.com/", {
          resolve: resolverWith(),
          transport,
          now,
        }),
      ),
    ).toBe("redirect-limit");

    // One original request and `MAX_REDIRECTS` more. A loop ends the same way,
    // which is why nothing here tries to detect one.
    expect(transport).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  it("ends a loop at the same limit", async () => {
    const transport = transportOf(
      ...Array.from({ length: MAX_REDIRECTS + 1 }, () =>
        redirectTo("https://example.com/round"),
      ),
    );

    expect(
      await kindOf(
        fetchWatchedPage("https://example.com/round", {
          resolve: resolverWith(),
          transport,
          now,
        }),
      ),
    ).toBe("redirect-limit");
  });
});

/**
 * The budget covers the call, not a request. Three slow redirects and one slow
 * request cost the same, which is the only version of this a tick can plan
 * around.
 */
describe("the time budget", () => {
  it("gives the first hop the whole of it", async () => {
    const transport = transportOf(page);

    await fetchWatchedPage("https://example.com/", {
      resolve: resolverWith(),
      transport,
      now,
    });

    expect(transport).toHaveBeenCalledWith(
      expect.any(URL),
      expect.any(Array),
      FETCH_BUDGET_MS,
    );
  });

  it("gives a later hop only what is left", async () => {
    const transport = vi.fn(async (): Promise<Hop> => {
      clock += 5_000;
      return transportScript.shift() ?? page;
    });
    const transportScript: Hop[] = [redirectTo("https://example.com/next")];

    await fetchWatchedPage("https://example.com/", {
      resolve: resolverWith(),
      transport,
      now,
    });

    expect(transport).toHaveBeenNthCalledWith(
      2,
      expect.any(URL),
      expect.any(Array),
      FETCH_BUDGET_MS - 5_000,
    );
  });

  it("stops rather than starting a hop with no time left", async () => {
    const transport = vi.fn(async (): Promise<Hop> => {
      clock += FETCH_BUDGET_MS;
      return redirectTo("https://example.com/next");
    });

    expect(
      await kindOf(
        fetchWatchedPage("https://example.com/", {
          resolve: resolverWith(),
          transport,
          now,
        }),
      ),
    ).toBe("timeout");

    expect(transport).toHaveBeenCalledTimes(1);
  });
});

/**
 * Failures the transport reports are the transport's to name. This is here to
 * fix that they travel — a fetch that swallowed one and returned something
 * would be worse than one that failed.
 */
describe("failures from the transport", () => {
  it.each([
    "http-error",
    "response-too-large",
    "unsupported-content-type",
    "connect-failure",
    "timeout",
  ] as const)("passes %s through", async (kind) => {
    const transport: Transport = vi.fn(async () => {
      const { WatcherError } = await import("@/lib/watcher/errors");
      throw new WatcherError(kind, "something went wrong");
    });

    expect(
      await kindOf(
        fetchWatchedPage("https://example.com/", {
          resolve: resolverWith(),
          transport,
          now,
        }),
      ),
    ).toBe(kind);
  });
});
