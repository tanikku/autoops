import "server-only";

import { DiscoveryProviderError } from "@/lib/discovery/provider";

/**
 * The one request a discovery provider is allowed to make.
 *
 * **This is not Safe Fetch, and it must not become it.** `lib/watcher/` fetches
 * an address somebody typed into a form: it resolves the name itself, refuses
 * private addresses, pins the socket to what it verified, and treats every
 * redirect as a new address to check — because the target is chosen by a user
 * and could be anything, including the inside of the network. Here the target is
 * one host this repository names, reached to run an operator's own API key
 * against it. The threat models are opposites, and a client that tried to serve
 * both would have to relax one of them.
 *
 * **So none of Safe Fetch's invariants are touched by this file.** Nothing here
 * imports `lib/watcher/`, and nothing there imports this.
 *
 * **What the key means for what may be logged.** A YouTube request carries its
 * key in the query string, so the URL *is* a secret. Nothing in this module
 * logs, and no error it raises carries a URL, a status, a response body, or a
 * `cause` — see `DiscoveryProviderError`.
 */

/**
 * The only host this speaks to.
 *
 * **A constant rather than a parameter.** A caller that could name the host
 * could name another one, and then the fixed-endpoint property would be a thing
 * every caller has to keep rather than a thing that is true.
 */
const TRUSTED_ORIGIN = "https://www.googleapis.com";

/**
 * How long one search may take.
 *
 * **Twenty seconds, matching the website fetch budget rather than any AI
 * timeout.** Both bound one network step inside a run that has more to do
 * afterwards; the AI timeouts bound the work a run's result is made of. A search
 * that has not answered in twenty seconds is not going to change what the run
 * produces, and the tick has other workers waiting.
 */
export const DISCOVERY_REQUEST_TIMEOUT_MS = 20_000;

/**
 * The most of an answer that will be read.
 *
 * Two megabytes is far more than a twenty-five item search result, and the point
 * is not the number: a response read without a ceiling is a response whose size
 * is decided by whoever is answering. The body is counted as it arrives rather
 * than after, because a limit applied to an already-buffered body is not a
 * limit.
 */
export const DISCOVERY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Builds the one URL this module will request.
 *
 * **The origin is not the caller's to supply**, and `new URL` alone does not
 * make that true — a path of `//elsewhere.example` resolves to another host
 * entirely. The result is checked against the constant afterwards, and a
 * mismatch throws a plain `Error` rather than a `DiscoveryProviderError`:
 * nothing in this repository can reach it, so it would be a bug in Koqentra
 * rather than something a provider did, and reporting a bug as a transient
 * provider failure is how a bug gets retried instead of fixed.
 */
function trustedUrl(path: string, params: Record<string, string>): URL {
  const url = new URL(path, TRUSTED_ORIGIN);

  if (url.origin !== TRUSTED_ORIGIN || url.protocol !== "https:") {
    throw new Error("A discovery request may only be made to the trusted host.");
  }

  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }

  return url;
}

/**
 * Reads a body, stopping if it grows past what may be read.
 *
 * Counted in bytes as they arrive. `content-length` is not trusted for this: it
 * is a claim by the answering server, and a body that disagrees with it is
 * exactly the case a ceiling exists for.
 */
async function readBoundedText(response: Response): Promise<string> {
  const body = response.body;

  if (body === null) {
    throw new DiscoveryProviderError("unreadable");
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      total += value.byteLength;

      if (total > DISCOVERY_MAX_RESPONSE_BYTES) {
        throw new DiscoveryProviderError("unreadable");
      }

      chunks.push(value);
    }
  } finally {
    // Whatever happened, the stream goes. Leaving it open holds a connection
    // for an answer nobody is going to finish reading.
    await reader.cancel().catch(() => {});
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(joined);
}

/**
 * One `GET` to the trusted host, answered as parsed JSON.
 *
 * **Everything it sends is fixed.** A `GET`, one `Accept`, and nothing else — no
 * cookies, no `Authorization`, no headers from anywhere near a user, and no
 * body. The key travels as a query parameter because that is how the API takes
 * it, and it is never read back out of the URL by anything here.
 *
 * **`redirect: "manual"`, and a redirect is a failure.** A fixed endpoint that
 * answers with somewhere else to go is not the endpoint this was built against;
 * following it would send the key to whatever host was named. There is nowhere
 * a redirect could legitimately lead.
 *
 * What comes back is `unknown`. Deciding whether it is the shape the API
 * documents is the provider's job — this one only decides whether there is JSON.
 */
export async function fetchTrustedJson(
  path: string,
  params: Record<string, string>,
): Promise<unknown> {
  const url = trustedUrl(path, params);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(DISCOVERY_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // `AbortSignal.timeout` rejects with a `TimeoutError`; an abort from
    // anywhere else arrives as `AbortError`. Everything else that stops a
    // `fetch` before it has an answer is the network. **The thrown value is
    // not kept** — it names the request it was aborting.
    const name = error instanceof Error ? error.name : "";
    throw new DiscoveryProviderError(
      name === "TimeoutError" || name === "AbortError" ? "timeout" : "network",
    );
  }

  // A manual redirect surfaces as an opaque response whose status is 0, or as
  // the 3xx itself depending on the runtime. Both are the same answer here.
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    throw new DiscoveryProviderError("rejected");
  }

  if (!response.ok) {
    // **The status and the body both stop here.** A provider's error body can
    // quote the request it was given, and a discovery request contains the key.
    throw new DiscoveryProviderError("rejected");
  }

  const text = await readBoundedText(response);

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DiscoveryProviderError("unreadable");
  }
}
