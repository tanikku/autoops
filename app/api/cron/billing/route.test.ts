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

/** What the health check reads after the sweep: nothing stale, by default. */
const pendingCount = vi.fn();
const pendingFindFirst = vi.fn();
const openCount = vi.fn();
const openFindFirst = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    billingReconciliation: { count: pendingCount, findFirst: pendingFindFirst },
    checkoutAttempt: { count: openCount, findFirst: openFindFirst },
  },
}));
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
    .mockResolvedValue({
      examined: 2,
      outcomes: { applied: 1, "not-claimed": 1 },
      sources: { pending: 1, periodic: 1 },
      checkoutRecovery: {},
      reasons: {},
      items: [],
    });
  resolveProviderReader.mockClear();
  pendingCount.mockReset().mockResolvedValue(0);
  pendingFindFirst.mockReset().mockResolvedValue(null);
  openCount.mockReset().mockResolvedValue(0);
  openFindFirst.mockReset().mockResolvedValue(null);

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
      sources: { periodic: 1 },
      checkoutRecovery: {},
      reasons: {},
      items: [
        { provider: "stripe", providerSubscriptionId: "sub_secret", outcome: "applied" },
      ],
    });

    const body = JSON.stringify(await (await tick(`Bearer ${SECRET}`)).json());

    expect(body).not.toContain("sub_secret");
  });

  /** Where each came from is in the log line, and only as counts. */
  it("logs how many came from each source", async () => {
    sweepBillingReconciliations.mockResolvedValue({
      examined: 3,
      outcomes: { applied: 3 },
      sources: { pending: 1, "unpaid-confirmation": 1, periodic: 1 },
      checkoutRecovery: {},
      reasons: {},
      items: [
        {
          provider: "stripe",
          providerSubscriptionId: "sub_secret",
          outcome: "applied",
          source: "periodic",
        },
      ],
    });

    const response = await tick(`Bearer ${SECRET}`);
    const line = logs.find((entry) => entry.includes("sweep finished")) ?? "";

    expect(line).toContain("sources: pending=1 unpaid-confirmation=1 periodic=1");
    expect(line).not.toContain("sub_secret");
    // The answer keeps its shape; sources are for the log.
    expect(Object.keys(await response.json()).sort()).toEqual([
      "examined",
      "outcomes",
      "success",
    ]);
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

/**
 * **503 only for what no retry will fix.** The sweep's own work is done either
 * way; the status is what stops the cron chain before the heartbeat.
 */
describe("when billing is critically broken", () => {
  const healthLine = () => logs.find((line) => line.includes("critical health")) ?? "";

  it("answers 200 and says so when nothing is critical", async () => {
    const response = await tick(`Bearer ${SECRET}`);

    expect(response.status).toBe(200);
    expect((await response.json()).success).toBe(true);
    expect(healthLine()).toContain("critical=false");
    expect(healthLine()).toContain("provider-config=0 stale-pending=0 stale-open-checkout=0");
  });

  it.each(["no-secret-key", "no-livemode-flag", "bad-livemode-flag", "key-mode-mismatch"])(
    "answers 503 on %s",
    async (outcome) => {
      sweepBillingReconciliations.mockResolvedValue({
        examined: 1,
        outcomes: { [outcome]: 1 },
        sources: { pending: 1 },
        checkoutRecovery: {},
        reasons: {},
        items: [],
      });

      const response = await tick(`Bearer ${SECRET}`);

      expect(response.status).toBe(503);
      expect(healthLine()).toContain("critical=true provider-config=1");
    },
  );

  it("answers 503 when work has been owing for an hour", async () => {
    pendingCount.mockResolvedValue(2);
    pendingFindFirst.mockResolvedValue({ pendingSince: new Date(Date.now() - 95 * 60 * 1000) });

    const response = await tick(`Bearer ${SECRET}`);

    expect(response.status).toBe(503);
    expect(healthLine()).toContain("stale-pending=2");
    expect(healthLine()).toMatch(/oldest-stale-pending-minutes=9[45]/);
  });

  it("answers 503 when a checkout has been open for a day", async () => {
    openCount.mockResolvedValue(1);
    openFindFirst.mockResolvedValue({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });

    const response = await tick(`Bearer ${SECRET}`);

    expect(response.status).toBe(503);
    expect(healthLine()).toContain("stale-open-checkout=1");
  });

  it("answers 200 for one transient failure", async () => {
    sweepBillingReconciliations.mockResolvedValue({
      examined: 3,
      outcomes: { unavailable: 1, failed: 1, "not-claimed": 1 },
      sources: { pending: 3 },
      checkoutRecovery: { payable: 1, unreadable: 1, "already-known": 1 },
      reasons: { "unavailable:StripeConnectionError": 1 },
      items: [],
    });

    expect((await tick(`Bearer ${SECRET}`)).status).toBe(200);
  });

  /** The shape a caller reads does not change; only the status and `success`. */
  it("keeps the answer's shape when critical", async () => {
    pendingCount.mockResolvedValue(1);
    pendingFindFirst.mockResolvedValue({ pendingSince: new Date(Date.now() - 2 * 60 * 60 * 1000) });

    const body = await (await tick(`Bearer ${SECRET}`)).json();

    expect(body).toEqual({
      success: false,
      examined: 2,
      outcomes: { applied: 1, "not-claimed": 1 },
    });
  });

  /** Not knowing is not "fine": a check that cannot run stops the heartbeat too. */
  it("answers 500 when the check itself cannot run", async () => {
    pendingCount.mockRejectedValue(new Error("db down"));

    const response = await tick(`Bearer ${SECRET}`);

    expect(response.status).toBe(500);
    expect((await response.json()).success).toBe(false);
  });

  it("warns when critical, so the line stands out", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    openCount.mockResolvedValue(1);
    openFindFirst.mockResolvedValue({ createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) });

    await tick(`Bearer ${SECRET}`);

    expect(warned.mock.calls.flat().join(" ")).toContain("critical=true");
  });

  it("logs why, by reason, and nothing that identifies anybody", async () => {
    sweepBillingReconciliations.mockResolvedValue({
      examined: 3,
      outcomes: { refused: 1, "provider-domain-mismatch": 1, unavailable: 1 },
      sources: { pending: 3 },
      checkoutRecovery: {},
      reasons: {
        "refused:unknown-plan": 1,
        "provider-domain-mismatch:conflicting-subscription": 1,
        "unavailable:StripeConnectionError": 1,
      },
      items: [
        {
          provider: "stripe",
          providerSubscriptionId: "sub_secret",
          outcome: "refused",
          reason: "unknown-plan",
          source: "pending",
        },
      ],
    });

    await tick(`Bearer ${SECRET}`);
    const written = logs.join("\n");

    expect(written).toContain(
      "reasons: refused:unknown-plan=1 provider-domain-mismatch:conflicting-subscription=1 unavailable:StripeConnectionError=1",
    );
    expect(written).not.toContain("sub_secret");
    expect(written).not.toContain(SECRET);
  });

  /**
   * **Why a 503 reaches the alarm.** The cron calls this with
   * `curl --fail-with-body`, chained `A && B && (C || true)`: any status of 400
   * or more fails `B`, so the heartbeat `C` is never sent. That chain lives in
   * Railway, not here; what is fixed here is that README still records it.
   */
  it("relies on the documented cron chain", async () => {
    const { readFileSync } = await import("node:fs");
    const readme = readFileSync("README.md", "utf8");

    expect(readme).toContain("A && B && (C || true)");
    expect(readme).toContain("--fail-with-body");
  });
});
