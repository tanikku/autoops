import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The tick that reconciles subscriptions which owe a look.
 *
 * **Guarded by the same secret as the worker tick, and nothing else.** There is
 * no session here — a cron service has no login — so the shared secret is the
 * whole of the authentication, and a deployment that has not been given one
 * must refuse every request rather than run reconciliation for anybody who
 * finds the path.
 */

const sweepBillingReconciliations = vi.fn();
const resolveProviderReader = vi.fn(() => () => ({ unavailable: "x" }));

vi.mock("@/lib/billing/sweeper", () => ({ sweepBillingReconciliations }));
vi.mock("@/lib/billing/providers/stripe-runtime", () => ({
  resolveProviderReader,
}));

const { POST } = await import("@/app/api/cron/billing/route");

const SECRET = "cron-secret-for-tests-only";

function tick(authorization?: string) {
  return POST(
    new Request("https://app.example.invalid/api/cron/billing", {
      method: "POST",
      headers: authorization === undefined ? {} : { authorization },
    }),
  );
}

const logs: string[] = [];

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  sweepBillingReconciliations
    .mockReset()
    .mockResolvedValue({ examined: 2, outcomes: { applied: 1, "not-claimed": 1 }, items: [] });
  resolveProviderReader.mockClear();

  logs.length = 0;
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CRON_SECRET;
});

describe("who may ask for a sweep", () => {
  it.each([
    ["no authorization at all", undefined],
    ["something that is not a bearer token", "Basic abc"],
    ["the wrong secret", "Bearer not-the-secret"],
  ])("refuses a request with %s", async (_label, authorization) => {
    const response = await tick(authorization);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      success: false,
      error: "Unauthorized",
    });
    expect(sweepBillingReconciliations).not.toHaveBeenCalled();
  });

  /** Fails closed: a missing variable must not leave the path open. */
  it("refuses everything when this deployment has no secret", async () => {
    delete process.env.CRON_SECRET;

    const response = await tick(`Bearer ${SECRET}`);

    expect(response.status).toBe(401);
    expect(sweepBillingReconciliations).not.toHaveBeenCalled();
  });

  it("accepts the secret it was configured with", async () => {
    const response = await tick(`Bearer ${SECRET}`);

    expect(response.status).toBe(200);
    expect(sweepBillingReconciliations).toHaveBeenCalledTimes(1);
  });

  it("never writes the secret or the header anywhere", async () => {
    await tick("Bearer not-the-secret");
    await tick(undefined);

    const written = logs.join("\n");

    expect(written).not.toContain(SECRET);
    expect(written).not.toContain("not-the-secret");
  });
});

describe("what a sweep reports", () => {
  it("answers with counts", async () => {
    const response = await tick(`Bearer ${SECRET}`);

    expect(await response.json()).toEqual({
      success: true,
      examined: 2,
      outcomes: { applied: 1, "not-claimed": 1 },
    });
  });

  /** Counts belong in the answer; which account is which does not. */
  it("answers with no subscription or account in it", async () => {
    sweepBillingReconciliations.mockResolvedValue({
      examined: 1,
      outcomes: { applied: 1 },
      items: [
        { provider: "stripe", providerSubscriptionId: "sub_secret", outcome: "applied" },
      ],
    });

    const body = JSON.stringify(await (await tick(`Bearer ${SECRET}`)).json());

    expect(body).not.toContain("sub_secret");
  });

  it("resolves readers per provider rather than holding one", async () => {
    await tick(`Bearer ${SECRET}`);

    expect(resolveProviderReader).toHaveBeenCalledTimes(1);
    expect(sweepBillingReconciliations.mock.calls[0][0]).toHaveProperty(
      "resolveReader",
    );
  });
});

describe("when a sweep fails", () => {
  it("answers safely", async () => {
    sweepBillingReconciliations.mockRejectedValue(new Error("everything broke"));

    const response = await tick(`Bearer ${SECRET}`);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: "Internal Server Error",
    });
  });

  it("says nothing of the cause to the caller", async () => {
    sweepBillingReconciliations.mockRejectedValue(
      new Error("postgres://user:pw@host refused"),
    );

    const body = JSON.stringify(await (await tick(`Bearer ${SECRET}`)).json());

    expect(body).not.toContain("postgres");
    expect(body).not.toContain("pw@");
  });
});

describe("what the route is not", () => {
  it("asks for no session", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/api/cron/billing/route.ts", "utf8");

    expect(source).not.toContain("auth(");
    expect(source).not.toContain("getServerSession");
  });

  /** One cron service, one secret: a second would be a second thing to rotate. */
  it("uses the same secret as the worker tick", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/api/cron/billing/route.ts", "utf8");

    expect(source).toContain("process.env.CRON_SECRET");
    expect(source).toContain("timingSafeEqual");
  });

  it("knows nothing about workers", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/api/cron/billing/route.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of ["dispatchDueWorkers", "Routine", "executionLease"]) {
      expect(source, `mentions ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("runs on the Node runtime", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/api/cron/billing/route.ts", "utf8");

    expect(source).toContain('export const runtime = "nodejs"');
  });
});
