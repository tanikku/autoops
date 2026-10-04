import { describe, expect, it } from "vitest";
import type { EffectiveEntitlement } from "@/lib/entitlements/types";
import type { EmailEntitlement } from "@/lib/plans";
import {
  emailEntitlementOf,
  entitlementAllowsEmail,
  shouldSendRunEmail,
} from "@/lib/notify/email-entitlement";

/**
 * Which workers a plan lets email their owner.
 *
 * **Pure, so every plan and every edge is a line here.** The send path and the
 * save path both lean on these answers; what they add is when they ask.
 */

function entitlement(
  email: EmailEntitlement,
  overrides: Partial<EffectiveEntitlement> = {},
): EffectiveEntitlement {
  return {
    state: "active",
    entitled: true,
    plan: email === "one-worker" ? "lite" : "standard",
    limits: {
      activeWorkerLimit: 2,
      aiProcessingLimit: 30,
      manualRunLimit: 20,
      discoveryLimit: 10,
      history: { kind: "days", days: 7 },
      email,
    },
    trial: null,
    period: null,
    expiresAt: null,
    notificationWorkerId: null,
    ...overrides,
  };
}

describe("what a plan lets workers do", () => {
  it("reads the plan's own email entitlement while it is live", () => {
    expect(emailEntitlementOf(entitlement("one-worker"))).toBe("one-worker");
    expect(emailEntitlementOf(entitlement("all-workers"))).toBe("all-workers");
  });

  it("is none for an account the plan no longer covers", () => {
    expect(
      emailEntitlementOf(entitlement("all-workers", { entitled: false, state: "expired" })),
    ).toBe("none");
  });

  it("is none for an account with no plan at all", () => {
    expect(
      emailEntitlementOf(entitlement("all-workers", { entitled: false, limits: null })),
    ).toBe("none");
  });
});

describe("entitlementAllowsEmail", () => {
  it("refuses every worker when the plan allows none", () => {
    expect(entitlementAllowsEmail(entitlement("none"), "worker-1")).toBe(false);
  });

  it("allows every worker when the plan allows all", () => {
    expect(entitlementAllowsEmail(entitlement("all-workers"), "worker-1")).toBe(true);
    expect(entitlementAllowsEmail(entitlement("all-workers"), "worker-2")).toBe(true);
  });

  it("allows the chosen worker on a one-worker plan", () => {
    expect(
      entitlementAllowsEmail(
        entitlement("one-worker", { notificationWorkerId: "worker-1" }),
        "worker-1",
      ),
    ).toBe(true);
  });

  it("refuses any other worker on a one-worker plan", () => {
    expect(
      entitlementAllowsEmail(
        entitlement("one-worker", { notificationWorkerId: "worker-1" }),
        "worker-2",
      ),
    ).toBe(false);
  });

  /** Nobody chosen is nobody allowed, never anybody. */
  it("refuses every worker on a one-worker plan with nobody chosen", () => {
    expect(entitlementAllowsEmail(entitlement("one-worker"), "worker-1")).toBe(false);
  });

  /** A choice left over from a lapsed plan grants nothing. */
  it("refuses even the chosen worker once the plan has lapsed", () => {
    expect(
      entitlementAllowsEmail(
        entitlement("one-worker", {
          notificationWorkerId: "worker-1",
          entitled: false,
          state: "expired",
        }),
        "worker-1",
      ),
    ).toBe(false);
  });

  /** A Lite choice carried into a plan that allows all is simply not consulted. */
  it("ignores a carried-over choice on a plan that allows all", () => {
    expect(
      entitlementAllowsEmail(
        entitlement("all-workers", { notificationWorkerId: "worker-1" }),
        "worker-2",
      ),
    ).toBe(true);
  });
});

describe("shouldSendRunEmail", () => {
  it("sends only when there is something to tell, the worker asked, and the plan allows", () => {
    expect(
      shouldSendRunEmail({
        notification: "prompt-completed",
        emailNotificationsEnabled: true,
        entitlementAllows: true,
      }),
    ).toBe(true);
  });

  it.each([
    [{ notification: null, emailNotificationsEnabled: true, entitlementAllows: true }],
    [{ notification: "failed", emailNotificationsEnabled: false, entitlementAllows: true }],
    [{ notification: "website-changed", emailNotificationsEnabled: true, entitlementAllows: false }],
  ] as const)("sends nothing for %o", (input) => {
    expect(shouldSendRunEmail(input)).toBe(false);
  });
});
