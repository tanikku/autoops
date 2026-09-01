import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMAIL_SEND_TIMEOUT_MS,
  isEmailDeliveryError,
  sendPlainTextEmail,
} from "@/lib/notify/email";

/**
 * The provider boundary, and what it refuses to let past.
 *
 * **Nothing here reaches Resend.** `fetch` is replaced for the whole file and
 * restored afterwards, so a test that forgot to arrange an answer fails on a
 * missing mock rather than on a request leaving the machine — the same guard
 * `lib/ai/claude-provider.test.ts` grew after a restored spy sent real
 * requests to a model.
 *
 * **The values below are invented.** No test reads a real key, and none of them
 * asserts on one: what is checked is that the key reaches the header and
 * nothing else.
 */

const API_KEY = "re_test_key_not_a_real_one";
const FROM = "Koqentra <notifications@example.test>";
const TO = "owner@example.test";

const fetchMock = vi.fn();
const realFetch = globalThis.fetch;

/** What Resend answers a successful send with. */
function accepted(body: unknown = { id: "message-1" }) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function refused(status: number) {
  return {
    ok: false,
    status,
    json: async () => ({ message: "the provider's own words" }),
  } as unknown as Response;
}

function message() {
  return { to: TO, subject: "[Koqentra] a subject", text: "a body" };
}

/** What the one request was given. */
function request(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, init };
}

function sentBody(): Record<string, unknown> {
  return JSON.parse(String(request().init.body));
}

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(accepted());
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  process.env.RESEND_API_KEY = API_KEY;
  process.env.EMAIL_FROM = FROM;
});

afterEach(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("what one send asks for", () => {
  it("posts one message to the Resend API", async () => {
    await sendPlainTextEmail(message());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(request().url).toBe("https://api.resend.com/emails");
    expect(request().init.method).toBe("POST");
  });

  it("carries the key in the authorization header and nowhere else", async () => {
    await sendPlainTextEmail(message());

    const headers = request().init.headers as Record<string, string>;

    expect(headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(String(request().init.body)).not.toContain(API_KEY);
  });

  it("sends the address it was given, as a list of exactly one", async () => {
    await sendPlainTextEmail(message());

    expect(sentBody().to).toEqual([TO]);
  });

  it("sends the configured sender rather than one written in code", async () => {
    process.env.EMAIL_FROM = "someone.else@example.test";

    await sendPlainTextEmail(message());

    expect(sentBody().from).toBe("someone.else@example.test");
  });

  /** **MVP is plain text.** A second body would be a second thing to keep true. */
  it("sends text and never html", async () => {
    await sendPlainTextEmail(message());

    expect(sentBody().text).toBe("a body");
    expect(sentBody()).not.toHaveProperty("html");
  });

  /**
   * **A bound, and one small enough that a tick cannot be spent here.** Five
   * dispatches per tick against the dispatcher's 240-second budget is the
   * comparison the number was chosen against.
   */
  it("gives the request a deadline rather than waiting forever", async () => {
    await sendPlainTextEmail(message());

    expect(request().init.signal).toBeInstanceOf(AbortSignal);
    expect(EMAIL_SEND_TIMEOUT_MS).toBeGreaterThan(0);
    expect(EMAIL_SEND_TIMEOUT_MS * 5).toBeLessThan(240_000);
  });

  it("does not try again when a send fails", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    await expect(sendPlainTextEmail(message())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("when it is not configured", () => {
  it.each([
    ["the key is missing", "RESEND_API_KEY"],
    ["the sender is missing", "EMAIL_FROM"],
  ])("refuses before making a request because %s", async (_label, variable) => {
    delete process.env[variable];

    await expect(sendPlainTextEmail(message())).rejects.toMatchObject({
      reason: "not-configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a blank value as a missing one", async () => {
    process.env.RESEND_API_KEY = "   ";

    await expect(sendPlainTextEmail(message())).rejects.toMatchObject({
      reason: "not-configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("how a failure is named", () => {
  it("calls a deadline a timeout", async () => {
    const error = new Error("timed out");
    error.name = "TimeoutError";
    fetchMock.mockRejectedValue(error);

    await expect(sendPlainTextEmail(message())).rejects.toMatchObject({
      reason: "timeout",
    });
  });

  it("calls an abort a timeout too", async () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    fetchMock.mockRejectedValue(error);

    await expect(sendPlainTextEmail(message())).rejects.toMatchObject({
      reason: "timeout",
    });
  });

  it("calls anything else that never answered the network", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    await expect(sendPlainTextEmail(message())).rejects.toMatchObject({
      reason: "network",
    });
  });

  it.each([400, 401, 422, 429, 500, 503])(
    "calls an answer of %i a rejection",
    async (status) => {
      fetchMock.mockResolvedValue(refused(status));

      await expect(sendPlainTextEmail(message())).rejects.toMatchObject({
        reason: "rejected",
      });
    },
  );

  it("calls a success that is not json unreadable", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("not json");
      },
    } as unknown as Response);

    await expect(sendPlainTextEmail(message())).rejects.toMatchObject({
      reason: "unreadable",
    });
  });

  it.each([
    ["an object with no id", {}],
    ["an id that is not a string", { id: 7 }],
    ["null", null],
  ])("calls a success carrying %s unreadable", async (_label, body) => {
    fetchMock.mockResolvedValue(accepted(body));

    await expect(sendPlainTextEmail(message())).rejects.toMatchObject({
      reason: "unreadable",
    });
  });
});

/**
 * **What must not travel with a failure.** The one caller writes the reason to
 * a log; anything the error carried would go with it.
 */
describe("what a failure does not carry", () => {
  it("keeps the key, the recipient and the provider's answer out of the error", async () => {
    fetchMock.mockResolvedValue(refused(422));

    const error = await sendPlainTextEmail(message()).catch(
      (thrown: unknown) => thrown,
    );

    expect(isEmailDeliveryError(error)).toBe(true);

    const seen = `${(error as Error).message} ${(error as Error).stack ?? ""}`;
    expect(seen).not.toContain(API_KEY);
    expect(seen).not.toContain(TO);
    expect(seen).not.toContain("the provider's own words");
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });
});
