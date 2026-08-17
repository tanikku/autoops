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
