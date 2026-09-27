import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Letting go of the slot a completed purchase was holding.
 *
 * **Almost every test here is a refusal.** Closing the wrong attempt would
 * release a slot somebody else's purchase is still holding, which is how an
 * account ends up paying twice — so the value of this module is in what it
 * declines to do, and that is what is pinned down below.
 */

const findUnique = vi.fn();
const closeCheckoutAttempt = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: { checkoutAttempt: { findUnique } },
}));
vi.mock("@/lib/billing/checkout-attempt", async () => {
  const actual = await import("@/lib/billing/checkout-attempt");

  return { ...actual, closeCheckoutAttempt };
});

const { closeSettledCheckoutAttempt } = await import(
  "@/lib/billing/checkout-cleanup"
);

const USER = "116614511017733764020";
/** The moment the provider's period began: the purchase's own instant. */
const STARTED = new Date("2026-09-27T06:34:36.000Z");

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    id: "attempt-1",
    plan: "lite",
    state: "open",
    createdAt: new Date("2026-09-27T06:32:59.000Z"),
    ...overrides,
  };
}

const close = (overrides: Record<string, unknown> = {}) =>
  closeSettledCheckoutAttempt({
    userId: USER,
    plan: "lite",
    subscriptionStartedAt: STARTED,
    ...overrides,
  });

beforeEach(() => {
  findUnique.mockReset().mockResolvedValue(attempt());
  closeCheckoutAttempt.mockReset().mockResolvedValue({ outcome: "closed" });
});

describe("the purchase this attempt was for", () => {
  it("closes it", async () => {
    await expect(close()).resolves.toEqual({ outcome: "closed" });
    expect(closeCheckoutAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: "attempt-1" }),
    );
  });

  it("looks for the account's own attempt", async () => {
    await close();

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER } }),
    );
  });

  it.each(["starting", "open"])("closes one in %s", async (state) => {
    findUnique.mockResolvedValue(attempt({ state }));

    await expect(close()).resolves.toEqual({ outcome: "closed" });
  });

  it("closes one taken at the same instant the period began", async () => {
    findUnique.mockResolvedValue(attempt({ createdAt: STARTED }));

    await expect(close()).resolves.toEqual({ outcome: "closed" });
  });

  it.each(["lite", "standard", "pro"] as const)(
    "closes a %s attempt for a %s activation",
    async (plan) => {
      findUnique.mockResolvedValue(attempt({ plan }));

      await expect(close({ plan })).resolves.toEqual({ outcome: "closed" });
    },
  );
});

describe("asking twice", () => {
  it("writes nothing the second time", async () => {
    findUnique.mockResolvedValue(attempt({ state: "closed" }));

    await expect(close()).resolves.toEqual({ outcome: "already-closed" });
    expect(closeCheckoutAttempt).not.toHaveBeenCalled();
  });

  /** A lapse or a concurrent close got there first: the slot is free either way. */
  it("accepts a close that found the row already closed", async () => {
    closeCheckoutAttempt.mockResolvedValue({ outcome: "already-closed" });

    await expect(close()).resolves.toEqual({ outcome: "already-closed" });
  });

  it("accepts a close that found no row", async () => {
    closeCheckoutAttempt.mockResolvedValue({ outcome: "not-found" });

    await expect(close()).resolves.toEqual({ outcome: "already-closed" });
  });
});

describe("what it refuses to close", () => {
  it("does nothing when the account has no attempt", async () => {
    findUnique.mockResolvedValue(null);

    await expect(close()).resolves.toEqual({ outcome: "no-attempt" });
    expect(closeCheckoutAttempt).not.toHaveBeenCalled();
  });

  /**
   * **A Standard attempt is not ended by a Lite subscription activating.**
   * Whatever produced that pair, releasing the slot would let a second purchase
   * start beside a first that is live at the provider.
   */
  it.each([
    ["standard", "lite"],
    ["lite", "standard"],
    ["pro", "lite"],
  ])("refuses a %s attempt for a %s activation", async (attemptPlan, plan) => {
    findUnique.mockResolvedValue(attempt({ plan: attemptPlan }));

    await expect(close({ plan })).resolves.toEqual({ outcome: "plan-mismatch" });
    expect(closeCheckoutAttempt).not.toHaveBeenCalled();
  });

  /**
   * **An attempt taken after the period began is a later purchase.** This is the
   * condition that makes a redelivery an hour afterwards safe.
   */
  it("refuses an attempt newer than the subscription", async () => {
    findUnique.mockResolvedValue(
      attempt({ createdAt: new Date("2026-09-27T06:40:00.000Z") }),
    );

    await expect(close()).resolves.toEqual({ outcome: "newer-attempt" });
    expect(closeCheckoutAttempt).not.toHaveBeenCalled();
  });

  it("refuses an attempt taken a millisecond later", async () => {
    findUnique.mockResolvedValue(
      attempt({ createdAt: new Date(STARTED.getTime() + 1) }),
    );

    await expect(close()).resolves.toEqual({ outcome: "newer-attempt" });
  });

  /** Only the three that can be bought have attempts to match. */
  it.each(["beta", "trial", "enterprise", ""])(
    "refuses an activation on %p",
    async (plan) => {
      await expect(close({ plan })).resolves.toEqual({
        outcome: "not-a-bought-plan",
      });
      expect(findUnique).not.toHaveBeenCalled();
      expect(closeCheckoutAttempt).not.toHaveBeenCalled();
    },
  );
});

describe("whose attempt it is", () => {
  /**
   * **One account, one attempt.** `CheckoutAttempt.userId` is unique, so there is
   * no set to choose from — the lookup is by the account the activation was for
   * and cannot return somebody else's.
   */
  it("never asks about an account other than the one that activated", async () => {
    await close({ userId: "999" });

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "999" } }),
    );
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});

describe("which client it uses", () => {
  it("uses the one it was handed", async () => {
    const client = {
      checkoutAttempt: { findUnique: vi.fn().mockResolvedValue(attempt()) },
    };

    await closeSettledCheckoutAttempt({
      userId: USER,
      plan: "lite",
      subscriptionStartedAt: STARTED,
      client: client as never,
    });

    expect(client.checkoutAttempt.findUnique).toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
    expect(closeCheckoutAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ client }),
    );
  });
});

describe("what this module is not", () => {
  it("runs only on the server", async () => {
    const { readFileSync } = await import("node:fs");

    expect(readFileSync("lib/billing/checkout-cleanup.ts", "utf8")).toContain(
      'import "server-only"',
    );
  });

  /**
   * **It goes through the existing primitive.** An ad-hoc update here would be a
   * second place that knows what closing an attempt means, and the first one
   * already refuses to touch a closed row.
   */
  it("writes through closeCheckoutAttempt and not around it", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/checkout-cleanup.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    expect(source).toContain("closeCheckoutAttempt(");

    for (const forbidden of [
      "checkoutAttempt.update",
      "checkoutAttempt.updateMany",
      "checkoutAttempt.delete",
      "checkoutAttempt.create",
      "$executeRaw",
      "$queryRaw",
    ]) {
      expect(source, `uses ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("touches no entitlement and no provider", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/checkout-cleanup.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of [
      "subscription.",
      "billingEvent",
      "usagePeriod",
      "Stripe",
      "fetch(",
      "computeEntitlement",
    ]) {
      expect(source, `touches ${forbidden}`).not.toContain(forbidden);
    }
  });
});
