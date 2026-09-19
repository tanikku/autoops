import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DISCOVERY_MAX_RESPONSE_BYTES,
  DISCOVERY_REQUEST_TIMEOUT_MS,
  fetchTrustedJson,
} from "@/lib/discovery/http";
import { isDiscoveryProviderError } from "@/lib/discovery/provider";

/**
 * The trusted request, and what it refuses to let past.
 *
 * **Nothing here reaches Google.** `fetch` is replaced for the whole file and
 * restored afterwards, so a test that forgot to arrange an answer fails on a
 * missing mock rather than on a request leaving the machine — the same guard
 * `lib/notify/email.test.ts` and `lib/ai/claude-provider.test.ts` keep.
 *
 * **The key below is invented.** No test reads a real one, and the assertions
 * about it are about where it goes and where it must not appear.
 */

const API_KEY = "yt_test_key_not_a_real_one";
const PATH = "/youtube/v3/search";

const fetchMock = vi.fn();
const realFetch = globalThis.fetch;

function answered(body: unknown, init?: { status?: number; type?: string }) {
  const text = JSON.stringify(body);
  const status = init?.status ?? 200;

  return {
    ok: status >= 200 && status < 300,
    status,
    type: init?.type ?? "basic",
    body: streamOf(new TextEncoder().encode(text)),
  } as unknown as Response;
}

/** A body that arrives in one chunk, as a real response's would. */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** A body that keeps arriving, so the ceiling is met while reading. */
function endlessStream(): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(64 * 1024);

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(chunk);
    },
  });
}

function requestedUrl(): URL {
  return new URL(String(fetchMock.mock.calls[0][0]));
}

function requestedInit(): RequestInit {
  return fetchMock.mock.calls[0][1] as RequestInit;
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isDiscoveryProviderError(error)) {
      return error.reason;
    }
    throw error;
  }

  throw new Error("expected the request to be refused");
}

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(answered({ items: [] }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("where the request goes", () => {
  it("only ever asks the one Google host, over HTTPS", async () => {
    await fetchTrustedJson(PATH, { key: API_KEY });

    const url = requestedUrl();

    expect(url.origin).toBe("https://www.googleapis.com");
    expect(url.protocol).toBe("https:");
    expect(url.pathname).toBe(PATH);
  });

  it("puts the parameters it was given in the query string", async () => {
    await fetchTrustedJson(PATH, { q: "ハリネズミ", maxResults: "25" });

    const url = requestedUrl();

    expect(url.searchParams.get("q")).toBe("ハリネズミ");
    expect(url.searchParams.get("maxResults")).toBe("25");
  });

  /**
   * **A path is not a host, and `new URL` alone does not make that true.** A
   * protocol-relative path resolves to somewhere else entirely, which would
   * send the key to whoever was named.
   */
  it.each(["//elsewhere.example/steal", "https://elsewhere.example/steal"])(
    "refuses to build a request for %s, and makes none",
    async (path) => {
      await expect(fetchTrustedJson(path, { key: API_KEY })).rejects.toThrow(
        /trusted host/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  /** A host escape is a bug in Koqentra, not something a provider did. */
  it("reports a host escape as a plain error rather than a provider failure", async () => {
    await fetchTrustedJson(PATH, {}).catch(() => {});

    const thrown = await fetchTrustedJson("//elsewhere.example", {}).catch(
      (error: unknown) => error,
    );

    expect(isDiscoveryProviderError(thrown)).toBe(false);
  });
});

describe("what the request carries", () => {
  it("sends a GET that asks for JSON and nothing else", async () => {
    await fetchTrustedJson(PATH, { key: API_KEY });

    const init = requestedInit();

    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ accept: "application/json" });
    expect(init.body).toBeUndefined();
  });

  /**
   * **No cookie and no `Authorization`.** The API takes its key as a query
   * parameter; a second place to put a credential is a second place to leak one.
   */
  it("sends no cookie and no authorization header", async () => {
    await fetchTrustedJson(PATH, { key: API_KEY });

    const headers = requestedInit().headers as Record<string, string>;
    const names = Object.keys(headers).map((name) => name.toLowerCase());

    expect(names).not.toContain("cookie");
    expect(names).not.toContain("authorization");
  });

  it("gives the call twenty seconds and no more", async () => {
    expect(DISCOVERY_REQUEST_TIMEOUT_MS).toBe(20_000);

    await fetchTrustedJson(PATH, {});

    expect(requestedInit().signal).toBeInstanceOf(AbortSignal);
  });
});

describe("redirects", () => {
  it("never follows one", async () => {
    await fetchTrustedJson(PATH, {});

    expect(requestedInit().redirect).toBe("manual");
  });

  it("treats an opaque redirect as a refusal", async () => {
    fetchMock.mockResolvedValue(answered({}, { status: 0, type: "opaqueredirect" }));

    expect(await reasonOf(fetchTrustedJson(PATH, {}))).toBe("rejected");
  });

  it.each([301, 302, 307, 308])("treats a %i as a refusal", async (status) => {
    fetchMock.mockResolvedValue(answered({}, { status }));

    expect(await reasonOf(fetchTrustedJson(PATH, {}))).toBe("rejected");
  });
});

describe("when the answer is not one", () => {
  it.each([400, 401, 403, 429, 500, 503])(
    "reports a %i as rejected",
    async (status) => {
      fetchMock.mockResolvedValue(answered({ error: "quota" }, { status }));

      expect(await reasonOf(fetchTrustedJson(PATH, {}))).toBe("rejected");
    },
  );

  it("reports a timeout as a timeout", async () => {
    const timeout = new Error("aborted");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValue(timeout);

    expect(await reasonOf(fetchTrustedJson(PATH, {}))).toBe("timeout");
  });

  it("reports an abort as a timeout", async () => {
    const aborted = new Error("aborted");
    aborted.name = "AbortError";
    fetchMock.mockRejectedValue(aborted);

    expect(await reasonOf(fetchTrustedJson(PATH, {}))).toBe("timeout");
  });

  it("reports anything else that stopped the call as the network", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    expect(await reasonOf(fetchTrustedJson(PATH, {}))).toBe("network");
  });

  it("reports a body that is not JSON as unreadable", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      type: "basic",
      body: streamOf(new TextEncoder().encode("<html>not json</html>")),
    } as unknown as Response);

    expect(await reasonOf(fetchTrustedJson(PATH, {}))).toBe("unreadable");
  });

  it("reports a success with no body at all as unreadable", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      type: "basic",
      body: null,
    } as unknown as Response);

    expect(await reasonOf(fetchTrustedJson(PATH, {}))).toBe("unreadable");
  });
});

describe("how much of an answer is read", () => {
  it("stops at two megabytes", () => {
    expect(DISCOVERY_MAX_RESPONSE_BYTES).toBe(2 * 1024 * 1024);
  });

  /**
   * **Counted as it arrives.** A ceiling applied to an already-buffered body is
   * not a ceiling, and `content-length` is a claim by whoever is answering.
   */
  it("refuses a body that keeps coming", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      type: "basic",
      body: endlessStream(),
    } as unknown as Response);

    expect(await reasonOf(fetchTrustedJson(PATH, {}))).toBe("unreadable");
  });
});

/**
 * The property the whole module exists for.
 *
 * A discovery request carries its key in the query string, so a URL that
 * travelled anywhere — a log line, an error message, a `cause` chain — would be
 * a key that travelled there.
 */
describe("the key never leaves with a failure", () => {
  it.each([
    ["a refusal", () => fetchMock.mockResolvedValue(answered({}, { status: 403 }))],
    ["a network failure", () => fetchMock.mockRejectedValue(new TypeError("fetch failed"))],
    [
      "an unreadable answer",
      () =>
        fetchMock.mockResolvedValue({
          ok: true,
          status: 200,
          type: "basic",
          body: streamOf(new TextEncoder().encode("nope")),
        } as unknown as Response),
    ],
  ])("keeps the key and the URL out of %s", async (_label, arrange) => {
    arrange();

    const thrown = (await fetchTrustedJson(PATH, { key: API_KEY }).catch(
      (error: unknown) => error,
    )) as Error;

    const written = `${thrown.name} ${thrown.message} ${String(thrown.stack ?? "")}`;

    expect(written).not.toContain(API_KEY);
    expect(written).not.toContain("googleapis.com");
    expect((thrown as { cause?: unknown }).cause).toBeUndefined();
  });
});
