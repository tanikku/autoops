import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Waiting for a purchase to appear.
 *
 * **There is no DOM in this project's tests, so the cadence is a pure function
 * and is tested as one.** `nextPollDelayMs`, `shouldKeepPolling` and `viewFor`
 * are the whole of the behaviour; what the effect does with them is wiring.
 *
 * **What the markup tests fix is mostly an absence.** No purchase to make, no
 * provider identifier, no account, and no claim that a payment succeeded before a
 * bought plan is active.
 */

vi.mock("@/app/dashboard/billing/return/actions", () => ({
  readCheckoutReturnStatusAction: vi.fn(),
}));

const {
  CheckoutReturnStatusPanel,
  POLL_BUDGET_MS,
  POLL_FAST_INTERVAL_MS,
  POLL_FAST_PHASE_MS,
  POLL_SLOW_INTERVAL_MS,
  nextPollDelayMs,
  shouldKeepPolling,
  viewFor,
} = await import("@/components/checkout-return-status");

type Labels = Parameters<typeof CheckoutReturnStatusPanel>[0]["labels"];

const LABELS: Labels = {
  pendingHeading: "PENDING-HEADING",
  pendingBody: "PENDING-BODY",
  pendingPatience: "PENDING-PATIENCE",
  activeHeading: "ACTIVE-{plan}-HEADING",
  activeBody: "ACTIVE-BODY",
  notEntitledHeading: "NOT-ENTITLED-HEADING",
  notEntitledBody: "NOT-ENTITLED-BODY",
  timedOutHeading: "TIMED-OUT-HEADING",
  timedOutBody: "TIMED-OUT-BODY",
  goToPlans: "GO-TO-PLANS",
  planNames: { lite: "Lite", standard: "Standard", pro: "Pro" },
};

const render = () =>
  renderToStaticMarkup(<CheckoutReturnStatusPanel labels={LABELS} />);

describe("what it shows before any answer", () => {
  /** The provider redirected. That is not yet a purchase. */
  it("waits rather than claiming anything", () => {
    const html = render();

    expect(html).toContain("PENDING-HEADING");
    expect(html).toContain("PENDING-BODY");
    expect(html).toContain("PENDING-PATIENCE");
  });

  it("claims no plan and no failure", () => {
    const html = render();

    expect(html).not.toContain("ACTIVE");
    expect(html).not.toContain("NOT-ENTITLED");
    expect(html).not.toContain("TIMED-OUT");
  });

  /** One control, and it goes to the page that says what the account is on. */
  it("offers a way onwards and no way to buy", () => {
    const html = render();

    expect(html).toContain("GO-TO-PLANS");
    expect(html).toContain('href="/dashboard/billing"');
    expect(html).not.toContain("<form");
    expect(html).not.toContain("action=");
  });
});

/**
 * The cadence.
 *
 * **Two rates because the two halves of the wait are different.** Production
 * measured 52 seconds for a purchase to land; the bound is a five-minute cron
 * cadence, and asking every two seconds for all of it would be a browser
 * hammering a server action to learn nothing.
 */
describe("how often it asks", () => {
  it.each([0, 1, 1_999, 15_000, 29_999])(
    "asks again in two seconds at %ims",
    (elapsed) => {
      expect(nextPollDelayMs(elapsed)).toBe(POLL_FAST_INTERVAL_MS);
    },
  );

  it.each([30_000, 30_001, 120_000, 329_999])(
    "asks again in five seconds at %ims",
    (elapsed) => {
      expect(nextPollDelayMs(elapsed)).toBe(POLL_SLOW_INTERVAL_MS);
    },
  );

  it("changes rate exactly at the end of the fast phase", () => {
    expect(nextPollDelayMs(POLL_FAST_PHASE_MS - 1)).toBe(POLL_FAST_INTERVAL_MS);
    expect(nextPollDelayMs(POLL_FAST_PHASE_MS)).toBe(POLL_SLOW_INTERVAL_MS);
  });

  /** The budget covers the worst cadence with room left over. */
  it("budgets longer than the cron cadence it waits on", () => {
    expect(POLL_BUDGET_MS).toBeGreaterThan(5 * 60 * 1000);
  });

  /** Deterministic: one client per purchase, so there is no herd to spread. */
  it("adds no jitter", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("components/checkout-return-status.tsx", "utf8");

    expect(source).not.toContain("Math.random");
  });
});

describe("when it stops asking", () => {
  it("keeps asking before any answer", () => {
    expect(shouldKeepPolling(null, 0)).toBe(true);
  });

  it("keeps asking while the answer is pending", () => {
    expect(shouldKeepPolling({ status: "pending" }, 10_000)).toBe(true);
  });

  /** A query that did not answer is the kind of thing that stops being true. */
  it("keeps asking after an unavailable answer", () => {
    expect(shouldKeepPolling({ status: "unavailable" }, 10_000)).toBe(true);
  });

  it("stops once a bought plan is active", () => {
    expect(shouldKeepPolling({ status: "active", plan: "lite" }, 10_000)).toBe(
      false,
    );
  });

  it("stops once the answer is settled as nothing", () => {
    expect(shouldKeepPolling({ status: "not-entitled" }, 10_000)).toBe(false);
  });

  it("stops when the budget runs out", () => {
    expect(shouldKeepPolling({ status: "pending" }, POLL_BUDGET_MS)).toBe(false);
    expect(shouldKeepPolling({ status: "pending" }, POLL_BUDGET_MS + 1)).toBe(
      false,
    );
    expect(shouldKeepPolling(null, POLL_BUDGET_MS)).toBe(false);
  });

  it("keeps asking one millisecond before the budget", () => {
    expect(shouldKeepPolling({ status: "pending" }, POLL_BUDGET_MS - 1)).toBe(
      true,
    );
  });

  /** One timer at a time: the next ask is only queued after one answered. */
  it("queues the next ask from inside the previous answer", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("components/checkout-return-status.tsx", "utf8");

    expect(source.match(/setTimeout\(/g) ?? []).toHaveLength(1);
    // An interval would keep firing while an answer was still in flight.
    expect(source).not.toContain("setInterval");
  });

  /** Leaving the page ends the wait: the effect clears its timer and its flag. */
  it("stops when the page goes away", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("components/checkout-return-status.tsx", "utf8");

    expect(source).toContain("clearTimeout(timer)");
    expect(source).toContain("cancelled = true");
  });
});

/**
 * Which of the four things is shown.
 *
 * **Running out of time is its own view**, because the copy has to change:
 * waiting says "a moment", giving up says "check again shortly". A settled answer
 * is shown as itself however long it took.
 */
describe("what an answer means on screen", () => {
  it.each([false, true])("shows a pending answer as waiting (exhausted %s)", (exhausted) => {
    expect(viewFor({ status: "pending" }, exhausted)).toBe(
      exhausted ? "timed-out" : "pending",
    );
  });

  it("shows an active answer as success whenever it arrives", () => {
    expect(viewFor({ status: "active", plan: "lite" }, false)).toBe("active");
    expect(viewFor({ status: "active", plan: "lite" }, true)).toBe("active");
  });

  it("shows a settled nothing as itself whenever it arrives", () => {
    expect(viewFor({ status: "not-entitled" }, false)).toBe("not-entitled");
    expect(viewFor({ status: "not-entitled" }, true)).toBe("not-entitled");
  });

  it("shows no answer yet as waiting", () => {
    expect(viewFor(null, false)).toBe("pending");
  });

  /** An unavailable answer is a wait, not a verdict. */
  it("shows an unavailable answer as waiting", () => {
    expect(viewFor({ status: "unavailable" }, false)).toBe("pending");
  });

  it("shows an unavailable answer that ran out of time as still confirming", () => {
    expect(viewFor({ status: "unavailable" }, true)).toBe("timed-out");
  });
});

describe("what never reaches the browser", () => {
  it("renders no identifier", () => {
    const html = render().toLowerCase();

    for (const forbidden of [
      "cs_test",
      "cs_live",
      "price_",
      "cus_",
      "sub_",
      "sk_",
      "attempt",
      "stripe",
      "sandbox",
      "checkout_sandbox_user_ids",
      "reconciliation",
    ]) {
      expect(html, `renders ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("renders no account details", () => {
    const html = render();

    expect(html).not.toContain("@");
    expect(html).not.toMatch(/\d{10,}/);
  });

  it("holds nothing a caller could aim at somebody else", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("components/checkout-return-status.tsx", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of [
      "userId",
      "email",
      "priceId",
      "customerId",
      "providerSubscriptionId",
      "sessionId",
      "attemptId",
      "searchParams",
      "useSearchParams",
      "process.env",
      "new Stripe",
      "fetch(",
      "prisma",
    ]) {
      expect(source, `holds ${forbidden}`).not.toContain(forbidden);
    }
  });

  /** The action takes nothing, so the call site cannot send anything either. */
  it("calls the status action with no arguments", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("components/checkout-return-status.tsx", "utf8");

    expect(source).toContain("readCheckoutReturnStatusAction()");
  });
});
