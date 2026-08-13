import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isWatcherError, type WatcherError } from "@/lib/watcher/errors";
import { fetchWatchedPage } from "@/lib/watcher/fetch";
import { USER_AGENT } from "@/lib/watcher/limits";
import { nodeTransport } from "@/lib/watcher/transport";

/**
 * The one thing every other test in this directory takes on trust: that the
 * addresses handed to `nodeTransport` are the addresses the socket goes to.
 *
 * Everywhere else the transport is replaced, which is what makes the redirect
 * policy testable — and leaves the seam itself unexercised. The safety argument
 * for the whole watcher rests on `lookup` deciding the connection, and until
 * this file that rested on reading Node's types. Here it runs, on whatever
 * version CI is using.
 *
 * **The hostname is a `.invalid` name, and that is the proof.** RFC 2606
 * reserves the TLD precisely so that it never resolves; if the request arrives
 * at the server below, no name server was consulted, because none could have
 * answered. Nothing here needs to intercept DNS to show that DNS was not used.
 *
 * ---
 *
 * **THIS IS NOT A SAFE FETCH. It reaches loopback on purpose.**
 *
 * `nodeTransport` is the layer *below* the address checks: it connects to what
 * it is given and asks no questions, which is exactly why the checks live above
 * it. Calling it directly with `127.0.0.1` is how the seam gets tested at all,
 * and it says nothing whatever about what a watched page may point at.
 *
 * **Through the ordinary path, loopback is refused** — the last test in this
 * file is here to keep that unambiguous, and no production code knows this file
 * exists. There is no test mode, no flag, and no relaxed contract.
 */

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

const FAKE_HOST = "not-a-real-host.invalid";

let server: http.Server;
let port: number;
let handler: Handler;

/** Responses a test left open, so the server can still be closed after it. */
const openResponses = new Set<http.ServerResponse>();

beforeAll(async () => {
  server = http.createServer((request, response) => {
    openResponses.add(response);
    response.on("close", () => openResponses.delete(response));
    handler(request, response);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  port = (server.address() as AddressInfo).port;
});

afterEach(() => {
  for (const response of openResponses) {
    response.destroy();
  }
  openResponses.clear();
});

/**
 * **The resource check.** `close` waits for every connection to end, so it only
 * settles if the transport let go of its socket on every path a test took. A
 * leak here is a hung test rather than a passing one.
 */
afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

/** A URL naming a host that cannot resolve, on the port the server is on. */
function target(path = "/"): URL {
  return new URL(`http://${FAKE_HOST}:${port}${path}`);
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return isWatcherError(error)
      ? (error as WatcherError).kind
      : `not-a-watcher-error: ${String(error)}`;
  }

  return "returned";
}

describe("the request that actually goes out", () => {
  it("connects to the pinned address for a name that cannot be resolved", async () => {
    let seen: http.IncomingMessage | undefined;

    handler = (request, response) => {
      seen = request;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<p>hi</p>");
    };

    const hop = await nodeTransport(target("/page?q=1"), ["127.0.0.1"], 5_000);

    // Arriving at all is the finding: `not-a-real-host.invalid` has no address,
    // so the only thing that could have chosen 127.0.0.1 is the pinned lookup.
    expect(seen).toBeDefined();
    expect(hop).toEqual({
      kind: "page",
      status: 200,
      contentType: "text/html",
      body: "<p>hi</p>",
      byteLength: 9,
    });
  });

  it("asks for the path and query it was given, and nothing more", async () => {
    let requested: string | undefined;

    handler = (request, response) => {
      requested = request.url;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    };

    await nodeTransport(target("/page?q=1"), ["127.0.0.1"], 5_000);

    expect(requested).toBe("/page?q=1");
  });

  it("sends the name in the Host header, not the address it connected to", async () => {
    let seen: http.IncomingMessage | undefined;

    handler = (request, response) => {
      seen = request;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    };

    await nodeTransport(target(), ["127.0.0.1"], 5_000);

    expect(seen?.headers.host).toBe(`${FAKE_HOST}:${port}`);
    expect(seen?.headers.host).not.toContain("127.0.0.1");
  });

  it("sends a GET carrying nothing of the person whose worker it is", async () => {
    let seen: http.IncomingMessage | undefined;

    handler = (request, response) => {
      seen = request;
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<p>hi</p>");
    };

    await nodeTransport(target(), ["127.0.0.1"], 5_000);

    expect(seen?.method).toBe("GET");
    expect(seen?.headers["user-agent"]).toBe(USER_AGENT);
    expect(seen?.headers["accept-encoding"]).toBe("identity");
    expect(seen?.headers.cookie).toBeUndefined();
    expect(seen?.headers.authorization).toBeUndefined();
    // No body: neither of the two ways one would be announced is present.
    expect(seen?.headers["content-length"]).toBeUndefined();
    expect(seen?.headers["transfer-encoding"]).toBeUndefined();
  });
});

describe("what the transport makes of a real response", () => {
  it("reports a redirect rather than following it", async () => {
    handler = (_request, response) => {
      response.writeHead(302, { location: "https://elsewhere.example/" });
      response.end();
    };

    const hop = await nodeTransport(target(), ["127.0.0.1"], 5_000);

    expect(hop).toEqual({
      kind: "redirect",
      status: 302,
      location: "https://elsewhere.example/",
    });
  });

  it("refuses a body it cannot read as text", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "application/pdf" });
      response.end("%PDF-1.4");
    };

    expect(await kindOf(nodeTransport(target(), ["127.0.0.1"], 5_000))).toBe(
      "unsupported-content-type",
    );
  });

  it("reports what the site answered when it is not a success", async () => {
    handler = (_request, response) => {
      response.writeHead(404, { "content-type": "text/html" });
      response.end("<p>gone</p>");
    };

    expect(await kindOf(nodeTransport(target(), ["127.0.0.1"], 5_000))).toBe(
      "http-error",
    );
  });

  /**
   * A server that accepts the connection and then says nothing. A socket
   * timeout measures silence and would eventually catch this one, but not the
   * one that trickles — destroying the request is the bound that holds either
   * way, and this is where it is exercised against a real socket.
   */
  it("gives up on a response that never comes", async () => {
    handler = () => {
      // Deliberately no reply. `afterEach` destroys it.
    };

    expect(await kindOf(nodeTransport(target(), ["127.0.0.1"], 100))).toBe(
      "timeout",
    );
  });
});

/**
 * **The boundary, stated as a test.** Everything above reached loopback by
 * calling the transport directly, which is the one thing that skips the address
 * checks. Asked the way a worker would ask, the same address is refused before
 * a socket exists.
 */
describe("the same address through the ordinary path", () => {
  it("is refused, and nothing is connected to", async () => {
    let reached = false;
    handler = (_request, response) => {
      reached = true;
      response.end();
    };

    const kind = await kindOf(
      fetchWatchedPage("http://127.0.0.1/", {
        resolve: async () => ["127.0.0.1"],
      }),
    );

    expect(kind).toBe("blocked-address");
    expect(reached).toBe(false);
  });
});
