import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import {
  parseContentType,
  readBodyWithLimit,
  type SupportedContentType,
} from "@/lib/watcher/body";
import { createPinnedLookup } from "@/lib/watcher/dns";
import { WatcherError } from "@/lib/watcher/errors";
import { MAX_RESPONSE_BYTES, USER_AGENT } from "@/lib/watcher/limits";
import { hostAddress } from "@/lib/watcher/url";

/** What one request came back as: somewhere else to go, or a page. */
export type Hop =
  | { kind: "redirect"; status: number; location: string }
  | {
      kind: "page";
      status: number;
      contentType: SupportedContentType;
      body: string;
      byteLength: number;
    };

/**
 * One request, to addresses that have already been vetted.
 *
 * A seam, so the redirect policy above can be tested without a socket — and so
 * that whatever performs the request can be swapped without the policy noticing.
 * **It follows nothing**: a redirect comes back as a result for the caller to
 * decide about, because deciding here would put the address checks out of reach.
 */
export type Transport = (
  target: URL,
  addresses: string[],
  timeoutMs: number,
) => Promise<Hop>;

/**
 * The request AutoOps actually makes.
 *
 * **Everything it sends is fixed.** A `GET`, one User-Agent, an `Accept` for
 * the two types it can read, and nothing else — no cookies, no authorization,
 * no headers from anywhere near a user, and no body. There is nothing here for
 * a target to be told about the person whose worker this is, because there is
 * nothing about them in it.
 *
 * **`accept-encoding: identity`** asks for the body uncompressed. That is not
 * about bandwidth: a size limit applied to compressed bytes is not a size
 * limit, and a few kilobytes of gzip can expand into gigabytes. Refusing to
 * decompress means the number of bytes read is the number of bytes counted. A
 * server that compresses anyway is refused below rather than decoded.
 *
 * **`agent: false`** so the socket is this request's own. A pooled connection
 * is keyed by host and port and would be reused by a later request whose
 * addresses were checked separately — the whole point of pinning the lookup is
 * that this connection goes where this call verified, and a shared pool gives
 * that away.
 *
 * The `Host` header is set from the URL rather than from what is connected to,
 * which is why `setHost` is off: the connection is made to an address, and the
 * site still has to be told which name was asked for.
 */
export const nodeTransport: Transport = (target, addresses, timeoutMs) =>
  new Promise<Hop>((resolve, reject) => {
    const client = target.protocol === "https:" ? https : http;

    let settled = false;

    const request = client.request({
      protocol: target.protocol,
      hostname: hostAddress(target),
      port: target.port === "" ? undefined : Number(target.port),
      path: `${target.pathname}${target.search}`,
      method: "GET",
      headers: {
        host: target.host,
        "user-agent": USER_AGENT,
        accept: "text/html, text/plain",
        "accept-encoding": "identity",
      },
      setHost: false,
      agent: false,
      // The one line that makes any of the checking above mean anything: the
      // socket connects to these addresses and never asks a resolver for its
      // own.
      lookup: createPinnedLookup(addresses),
    });

    /**
     * The deadline for this hop, enforced on the request rather than on the
     * socket.
     *
     * A socket timeout measures silence, so a server that sends one byte a
     * second never trips it while never finishing either. Destroying the
     * request outright is the only bound that holds regardless of what arrives.
     */
    const expiry = setTimeout(() => {
      request.destroy(
        new WatcherError("timeout", "The page took too long to arrive."),
      );
    }, timeoutMs);

    function succeed(hop: Hop): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(expiry);
      resolve(hop);
    }

    function fail(error: unknown): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(expiry);
      request.destroy();
      reject(
        error instanceof WatcherError
          ? error
          : new WatcherError(
              "connect-failure",
              `Could not reach ${target.host}.`,
              { cause: error },
            ),
      );
    }

    request.on("error", fail);

    request.on("response", (response: IncomingMessage) => {
      void readResponse(response).then(succeed, (error: unknown) => {
        // Whatever happens to the body, the socket goes. Leaving it open would
        // hold a connection for a response nobody is going to read.
        response.destroy();
        fail(error);
      });
    });

    request.end();
  });

/**
 * Turns a response into a hop, or into the reason there is not one.
 *
 * The order matters: a redirect is recognised before the status is judged and
 * before the body is looked at, because a redirect's body is not the page and
 * its content type says nothing about where it points.
 */
async function readResponse(response: IncomingMessage): Promise<Hop> {
  const status = response.statusCode ?? 0;
  const location = header(response, "location");

  if (status >= 300 && status < 400) {
    if (location === undefined) {
      throw new WatcherError(
        "http-error",
        `The site answered ${status} without saying where to go.`,
      );
    }

    response.destroy();
    return { kind: "redirect", status, location };
  }

  if (status < 200 || status >= 300) {
    throw new WatcherError("http-error", `The site answered ${status}.`);
  }

  const encoding = header(response, "content-encoding");
  if (encoding !== undefined && encoding.toLowerCase() !== "identity") {
    throw new WatcherError(
      "unsupported-content-type",
      `The page arrived ${encoding}-encoded, which AutoOps does not decode.`,
    );
  }

  const contentType = parseContentType(header(response, "content-type"));
  if (contentType === null) {
    throw new WatcherError(
      "unsupported-content-type",
      "AutoOps can only read HTML and plain text pages.",
    );
  }

  const { text, byteLength } = await readBodyWithLimit(
    response,
    MAX_RESPONSE_BYTES,
  );

  return { kind: "page", status, contentType, body: text, byteLength };
}

/** A header as a single string, ignoring the repeated form nothing here uses. */
function header(response: IncomingMessage, name: string): string | undefined {
  const value = response.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
