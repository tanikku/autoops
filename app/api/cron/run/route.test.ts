import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the cron endpoint promises its caller, and what it refuses to tell it.
 *
 * Two things are being held here, and they are different in kind. The first is
 * a security contract: an endpoint that runs every worker on the platform is
 * reachable by anyone who can guess a header, so **what it rejects, and how
 * little it says while rejecting, is the point**. The second is the one
 * observability branch that has never run anywhere — the warning a slow tick
 * logs — which is reachable here in microseconds and only here.
 *
 * **The dispatcher is replaced, not exercised.** What a tick means, which
 * workers are due, what `dispatched` counts once it gets there — none of that
 * belongs to this file. The route turns a result into a response, and that
 * conversion is all these look at.
 *
 * **Log wording is deliberately not fixed.** The sentences below have been
 * rewritten several times and will be again; what matters is which stream they
 * went to and that neither carries the secret.
 */

const mocks = vi.hoisted(() => ({
  dispatchDueWorkers: vi.fn(),
  latestExecutionFailureAt: vi.fn(),
}));

vi.mock("@/lib/dispatcher", () => ({
  dispatchDueWorkers: mocks.dispatchDueWorkers,
}));

// Replaced for the same reason the dispatcher is: what it reads out of run
// history belongs to that module's own tests. What the route owes it is a call
// and a line, and that is what these look at.
vi.mock("@/lib/runs", () => ({
  latestExecutionFailureAt: mocks.latestExecutionFailureAt,
}));

const { POST } = await import("@/app/api/cron/run/route");

/**
 * Distinctive on purpose: every "does not leak" assertion below searches for
 * this string, so it has to be one nothing else would produce.
 */
const SECRET = "SUPER_SECRET_TEST_VALUE";

/** Restored after the file — the real value is never read or written. */
const originalSecret = process.env.CRON_SECRET;

let log: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

function post(headers: Record<string, string> = {}) {
  return POST(
    new Request("http://localhost/api/cron/run", { method: "POST", headers }),
  );
}

/** Everything a spy was handed, flattened, so a search covers every argument. */
function loggedText(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
}

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  mocks.dispatchDueWorkers
    .mockReset()
    .mockResolvedValue({ dispatched: [], failed: 0 });
  mocks.latestExecutionFailureAt.mockReset().mockResolvedValue(null);

  // Silenced as well as observed: a passing run should not print.
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

/**
 * Restores every spy, including the clock one that only two tests install —
 * and it runs even when a test fails partway.
 *
 * **Safe here in a way it was not for the provider tests.** The dispatcher is
 * a replaced module rather than a spy on something real, so a restore that
 * went wrong leaves it without an implementation and the next test fails
 * loudly. There is nothing underneath it to fall through to.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  if (originalSecret === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = originalSecret;
  }
});

/** The one body every rejection returns, whatever the reason was. */
const UNAUTHORIZED = { success: false, error: "Unauthorized" };

describe("a request that is turned away", () => {
  it("refuses everything when no secret is configured", async () => {
    delete process.env.CRON_SECRET;

    const response = await post({ authorization: `Bearer ${SECRET}` });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(UNAUTHORIZED);
    expect(mocks.dispatchDueWorkers).not.toHaveBeenCalled();
  });

  it("refuses a request with no Authorization header", async () => {
    const response = await post();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(UNAUTHORIZED);
    expect(mocks.dispatchDueWorkers).not.toHaveBeenCalled();
  });

  it("refuses a scheme that is not Bearer", async () => {
    const response = await post({ authorization: "Basic abc" });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(UNAUTHORIZED);
    expect(mocks.dispatchDueWorkers).not.toHaveBeenCalled();
  });

  it("refuses a token that does not match", async () => {
    const response = await post({ authorization: "Bearer WRONG_VALUE_ENTIRELY" });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(UNAUTHORIZED);
    expect(mocks.dispatchDueWorkers).not.toHaveBeenCalled();
  });

  /**
   * `timingSafeEqual` throws when the two buffers differ in length, so the
   * length is compared first and short-circuits. Without that guard a token of
   * the wrong length would come back **500** — an error rather than a refusal,
   * and one that tells the caller its guess was the wrong size.
   */
  it.each([
    ["shorter", "Bearer S"],
    ["longer", `Bearer ${SECRET}${SECRET}`],
  ])("refuses a %s token without erroring", async (_name, authorization) => {
    const response = await post({ authorization });

    expect(response.status).toBe(401);
    expect(response.status).not.toBe(500);
    expect(mocks.dispatchDueWorkers).not.toHaveBeenCalled();
  });

  it("refuses a Bearer prefix carrying nothing", async () => {
    const response = await post({ authorization: "Bearer " });

    expect(response.status).toBe(401);
    expect(mocks.dispatchDueWorkers).not.toHaveBeenCalled();
  });

  /** The scheme is matched exactly; only the header's *name* is case-blind. */
  it("refuses a lowercase bearer", async () => {
    const response = await post({ authorization: `bearer ${SECRET}` });

    expect(response.status).toBe(401);
    expect(mocks.dispatchDueWorkers).not.toHaveBeenCalled();
  });

  /**
   * **The four reasons are kept apart in the log and nowhere else.** A caller
   * that could tell "no header" from "wrong value" would be told whether it had
   * found the right shape, which is the first half of finding the right value.
   */
  it("says the same thing to all of them", async () => {
    delete process.env.CRON_SECRET;
    const noSecret = await (await post({ authorization: `Bearer ${SECRET}` })).json();

    process.env.CRON_SECRET = SECRET;
    const noHeader = await (await post()).json();
    const notBearer = await (await post({ authorization: "Basic abc" })).json();
    const mismatch = await (
      await post({ authorization: "Bearer WRONG_VALUE_ENTIRELY" })
    ).json();

    expect(noHeader).toEqual(noSecret);
    expect(notBearer).toEqual(noSecret);
    expect(mismatch).toEqual(noSecret);
  });
});

describe("what never leaves the server", () => {
  it("keeps the secret out of a refusal", async () => {
    const response = await post({ authorization: "Bearer WRONG_VALUE_ENTIRELY" });

    expect(JSON.stringify(await response.json())).not.toContain(SECRET);
  });

  it("keeps the secret out of a successful response", async () => {
    const response = await post({ authorization: `Bearer ${SECRET}` });

    expect(JSON.stringify(await response.json())).not.toContain(SECRET);
  });

  it("keeps the secret out of a failed tick", async () => {
    mocks.dispatchDueWorkers.mockRejectedValue(new Error("boom"));

    const response = await post({ authorization: `Bearer ${SECRET}` });

    expect(JSON.stringify(await response.json())).not.toContain(SECRET);
  });

  /**
   * A log that quoted the header would be storing the secret the moment a
   * caller finally got it right. Only the negative is asserted — what the line
   * *does* say is wording, and wording moves.
   */
  it("keeps the secret and the header out of the log", async () => {
    await post({ authorization: `Bearer ${SECRET}` });
    await post({ authorization: `Bearer WRONG_${SECRET}` });

    const written = [loggedText(warn), loggedText(log), loggedText(error)].join(
      "\n",
    );

    expect(written).not.toContain(SECRET);
    expect(written).not.toContain("Bearer ");
  });
});

describe("a tick that ran", () => {
  it("reports how many workers were handed off, as a number", async () => {
    mocks.dispatchDueWorkers.mockResolvedValue({
      dispatched: ["worker-1", "worker-2"],
      failed: 1,
    });

    const response = await post({ authorization: `Bearer ${SECRET}` });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      dispatched: 2,
      failed: 1,
    });
  });

  it("asks the dispatcher exactly once", async () => {
    await post({ authorization: `Bearer ${SECRET}` });

    expect(mocks.dispatchDueWorkers).toHaveBeenCalledTimes(1);
  });
});

describe("a tick that could not run", () => {
  beforeEach(() => {
    mocks.dispatchDueWorkers.mockRejectedValue(new Error("connection refused"));
  });

  it("answers 500 with nothing about what went wrong", async () => {
    const response = await post({ authorization: `Bearer ${SECRET}` });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: "Internal Server Error",
    });
  });

  it("keeps the cause out of the response and in the log", async () => {
    const response = await post({ authorization: `Bearer ${SECRET}` });

    expect(JSON.stringify(await response.json())).not.toContain(
      "connection refused",
    );
    expect(error).toHaveBeenCalled();
  });
});

/**
 * The threshold is `>=`, and **150,000ms is the first value on the warning
 * side**. Reaching it takes two readings of the clock rather than two and a
 * half minutes: the dispatcher is replaced, so nothing happens between them.
 */
describe("how long the tick took", () => {
  /** Makes the route measure exactly `durationMs` between its two readings. */
  function clockSpanning(durationMs: number) {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(durationMs);
  }

  it("logs a tick just under the threshold normally", async () => {
    clockSpanning(149_999);

    await post({ authorization: `Bearer ${SECRET}` });

    expect(loggedText(log)).toContain("duration_ms=149999");
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns on a tick that reaches the threshold exactly", async () => {
    clockSpanning(150_000);

    await post({ authorization: `Bearer ${SECRET}` });

    expect(loggedText(warn)).toContain("duration_ms=150000");
    expect(loggedText(warn)).toContain("over 150000ms");
    // The summary went to one stream or the other, never both. Other lines are
    // written to `log` on every tick, so this asks about the summary rather
    // than about the stream being untouched.
    expect(loggedText(log)).not.toContain("tick finished");
  });
});

/**
 * The line an operator can watch, and the two things it must not become.
 *
 * A tick that worked says nothing about the runs inside it: `dispatched` counts
 * workers that reached a provider, so a tick whose every run failed answers
 * `200` and its heartbeat still fires. The failures are in run history, where
 * only the account that owns the worker can see them.
 *
 * **This is an observation, not a verdict.** It may not change the response,
 * and it may not turn a tick that worked into one that did not — which is the
 * same rule the heartbeat follows on the other side of the same command.
 */
describe("when execution last failed", () => {
  it("reports the most recent failure on a tick that had none of its own", async () => {
    mocks.latestExecutionFailureAt.mockResolvedValue(
      new Date("2026-08-11T13:15:22.129Z"),
    );

    await post({ authorization: `Bearer ${SECRET}` });

    expect(loggedText(log)).toContain(
      "last_failed_at=2026-08-11T13:15:22.129Z",
    );
  });

  /**
   * Written whether or not there is anything to report, for the reason the due
   * count is: a line that only appears sometimes cannot tell "nothing has
   * failed" from "the check did not run".
   */
  it("says so plainly when nothing has ever failed", async () => {
    await post({ authorization: `Bearer ${SECRET}` });

    expect(loggedText(log)).toContain("last_failed_at=none");
  });

  it("is asked after the tick, so a failure from this tick is included", async () => {
    await post({ authorization: `Bearer ${SECRET}` });

    expect(
      mocks.dispatchDueWorkers.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.latestExecutionFailureAt.mock.invocationCallOrder[0]);
  });

  it("leaves the response exactly as it was", async () => {
    mocks.latestExecutionFailureAt.mockResolvedValue(new Date());

    const response = await post({ authorization: `Bearer ${SECRET}` });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      dispatched: 0,
      failed: 0,
    });
  });

  /** Watching something must not decide the outcome it was watching. */
  it("does not fail the tick when it cannot be read", async () => {
    mocks.latestExecutionFailureAt.mockRejectedValue(new Error("db down"));

    const response = await post({ authorization: `Bearer ${SECRET}` });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
  });

  it("still writes the tick summary when it cannot be read", async () => {
    mocks.latestExecutionFailureAt.mockRejectedValue(new Error("db down"));

    await post({ authorization: `Bearer ${SECRET}` });

    expect(loggedText(log)).toContain("tick finished");
  });
});
