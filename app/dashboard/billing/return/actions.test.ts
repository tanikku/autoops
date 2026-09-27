import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What a page waiting for a purchase to land may ask, and nothing else.
 *
 * **It takes no arguments, and that is the security property.** There is nothing
 * to send — not an account, not a session id, not a plan — so the answer cannot
 * be aimed at somebody else however the call is made. The tests below fix that
 * shape, and that a poll cannot cause anything.
 */

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  readCheckoutReturnStatus: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ requireUserId: mocks.requireUserId }));
vi.mock("@/lib/billing/checkout-return", () => ({
  readCheckoutReturnStatus: mocks.readCheckoutReturnStatus,
}));

const { readCheckoutReturnStatusAction } = await import(
  "@/app/dashboard/billing/return/actions"
);

const USER = "116614511017733764020";

const logs: string[] = [];

beforeEach(() => {
  mocks.requireUserId.mockReset().mockResolvedValue(USER);
  mocks.readCheckoutReturnStatus
    .mockReset()
    .mockResolvedValue({ status: "pending" });

  logs.length = 0;
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});

describe("whose status it reads", () => {
  it("asks about the authenticated account", async () => {
    await readCheckoutReturnStatusAction();

    expect(mocks.readCheckoutReturnStatus).toHaveBeenCalledWith(USER);
  });

  it("authenticates without provisioning a row", async () => {
    await readCheckoutReturnStatusAction();

    expect(mocks.requireUserId).toHaveBeenCalledTimes(1);
  });

  /** A redirect travels as a thrown error and is left to travel. */
  it("lets a signed-out visitor be redirected", async () => {
    const redirect = new Error("NEXT_REDIRECT");
    mocks.requireUserId.mockRejectedValue(redirect);

    await expect(readCheckoutReturnStatusAction()).rejects.toBe(redirect);
    expect(mocks.readCheckoutReturnStatus).not.toHaveBeenCalled();
  });

  /** There is no parameter to aim at another account, and none is invented. */
  it("takes no arguments", () => {
    expect(readCheckoutReturnStatusAction).toHaveLength(0);
  });
});

describe("what comes back", () => {
  it.each([
    { status: "pending" },
    { status: "active", plan: "lite" },
    { status: "not-entitled" },
    { status: "unavailable" },
  ] as const)("passes %o through unchanged", async (status) => {
    mocks.readCheckoutReturnStatus.mockResolvedValue(status);

    await expect(readCheckoutReturnStatusAction()).resolves.toEqual(status);
  });

  it("returns something serialisable", async () => {
    mocks.readCheckoutReturnStatus.mockResolvedValue({
      status: "active",
      plan: "pro",
    });

    const result = await readCheckoutReturnStatusAction();

    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

describe("when the read fails", () => {
  it("answers safely", async () => {
    mocks.readCheckoutReturnStatus.mockRejectedValue(new Error("boom"));

    await expect(readCheckoutReturnStatusAction()).resolves.toEqual({
      status: "unavailable",
    });
  });

  /** The category, never the cause: a driver's complaint names a host. */
  it("says nothing of the cause to the caller", async () => {
    mocks.readCheckoutReturnStatus.mockRejectedValue(
      new Error(`connection for ${USER} at db.internal refused`),
    );

    const result = await readCheckoutReturnStatusAction();

    expect(JSON.stringify(result)).not.toContain("db.internal");
    expect(JSON.stringify(result)).not.toContain(USER);
    expect(Object.keys(result)).toEqual(["status"]);
  });

  it("logs the category and not the message", async () => {
    mocks.readCheckoutReturnStatus.mockRejectedValue(
      new Error(`connection for ${USER} at db.internal refused`),
    );

    await readCheckoutReturnStatusAction();

    const logged = logs.join(" ");

    expect(logged).toContain("Error");
    expect(logged).not.toContain("db.internal");
    expect(logged).not.toContain(USER);
  });
});

describe("what this file is not", () => {
  it("is a server action", async () => {
    const { readFileSync } = await import("node:fs");

    expect(
      readFileSync("app/dashboard/billing/return/actions.ts", "utf8"),
    ).toMatch(/^"use server";/);
  });

  it("imports only a boundary's worth of things", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      "app/dashboard/billing/return/actions.ts",
      "utf8",
    );
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);

    expect(imports).toEqual([
      "@/lib/billing/checkout-return",
      "@/lib/session",
    ]);
  });

  /**
   * **A poll must not be able to cause anything.** No provider, no checkout, no
   * reconciliation, no sweep, no cron, and no write — including the account row,
   * which is why this does not provision.
   */
  it("causes nothing", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      "app/dashboard/billing/return/actions.ts",
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of [
      "startCheckout",
      "beginCheckoutAttempt",
      "closeCheckoutAttempt",
      "createStripeCheckoutProvider",
      "reconcileProviderSubscription",
      "sweep",
      "new Stripe",
      "fetch(",
      "prisma",
      "requireProvisionedUserId",
      "revalidatePath",
      "redirect(",
    ]) {
      expect(source, `uses ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("writes to no table", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      "app/dashboard/billing/return/actions.ts",
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const model of [
      "subscription",
      "checkoutAttempt",
      "usagePeriod",
      "billingEvent",
      "routine",
      "user",
    ]) {
      for (const write of ["create", "update", "updateMany", "upsert", "delete"]) {
        expect(source, `writes ${model}.${write}`).not.toContain(
          `${model}.${write}`,
        );
      }
    }
  });
});
