import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * The one control that opens the billing portal.
 *
 * **No DOM here, as for the checkout button**, so the rules — a second press is
 * not a press, an answer maps to one screen state — are pure functions tested
 * as functions, and the markup is tested as markup.
 */

vi.mock("@/app/dashboard/billing/portal-actions", () => ({
  openBillingPortalAction: vi.fn(),
}));

const { BillingPortalButton, fail, press, receive } = await import(
  "@/components/billing-portal-button"
);

type Labels = Parameters<typeof BillingPortalButton>[0]["labels"];

const LABELS: Labels = {
  manage: "MANAGE-LABEL",
  unavailable: "UNAVAILABLE-LABEL",
  pending: "PENDING-LABEL",
  messages: {
    notEligible: "NOT-ELIGIBLE-MESSAGE",
    unavailable: "UNAVAILABLE-MESSAGE",
  },
};

const render = (enabled: boolean) =>
  renderToStaticMarkup(<BillingPortalButton enabled={enabled} labels={LABELS} />);

const source = async () => {
  const { readFileSync } = await import("node:fs");

  return readFileSync("components/billing-portal-button.tsx", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
};

describe("whether it can be pressed", () => {
  it("is disabled and says so when the portal is not open to this account", () => {
    const html = render(false);

    expect(html).toContain('disabled=""');
    expect(html).toContain("UNAVAILABLE-LABEL");
    expect(html).not.toContain("MANAGE-LABEL");
  });

  it("offers the portal when it is", () => {
    const html = render(true);

    expect(html).toContain("MANAGE-LABEL");
    expect(html).not.toContain('disabled=""');
  });

  it("shows no message to begin with", () => {
    expect(render(true)).not.toContain("MESSAGE");
  });
});

describe("pressing it", () => {
  it("asks once from idle and becomes busy", () => {
    expect(press({ kind: "idle" })).toEqual({ step: { kind: "working" }, send: true });
  });

  /** The double click: a press while working sends nothing. */
  it("sends nothing while it is already working", () => {
    expect(press({ kind: "working" })).toEqual({
      step: { kind: "working" },
      send: false,
    });
  });

  it("may be pressed again after a message", () => {
    expect(press({ kind: "message", message: "unavailable" }).send).toBe(true);
  });

  /** Two clicks inside one frame: the ref, not the rendered step, decides. */
  it("guards a second click before the button re-renders", async () => {
    const code = await source();

    expect(code).toContain("press(inFlight.current ?");
    expect(code).toContain("inFlight.current = true");
  });
});

describe("reading the answer", () => {
  it("leaves for the address it was given, and stays busy on the way", () => {
    expect(
      receive({ outcome: "portal-ready", url: "https://billing.stripe.com/p/session/x" }),
    ).toEqual({
      step: { kind: "working" },
      url: "https://billing.stripe.com/p/session/x",
    });
  });

  it("says there is nothing to manage", () => {
    expect(receive({ outcome: "not-eligible" })).toEqual({
      step: { kind: "message", message: "notEligible" },
      url: null,
    });
  });

  it("says only that it is unavailable", () => {
    expect(receive({ outcome: "unavailable" })).toEqual({
      step: { kind: "message", message: "unavailable" },
      url: null,
    });
  });

  it("treats anything it does not recognise as unavailable", () => {
    expect(
      receive({ outcome: "something-new" } as unknown as Parameters<typeof receive>[0]),
    ).toEqual({ step: { kind: "message", message: "unavailable" }, url: null });
  });

  it("treats a call that failed as unavailable", () => {
    expect(fail()).toEqual({ kind: "message", message: "unavailable" });
  });

  it("navigates with window.location.assign and builds no address", async () => {
    const code = await source();

    expect(code).toContain("window.location.assign(outcome.url)");

    for (const forbidden of ["new URL", "https://", "window.location.href ="]) {
      expect(code, `builds ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("what never reaches the browser", () => {
  it.each([true, false])("renders no identifier when enabled is %s", (enabled) => {
    const html = render(enabled).toLowerCase();

    for (const forbidden of ["cus_", "sub_", "bps_", "sk_", "stripe", "sandbox"]) {
      expect(html, `renders ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("submits no form", () => {
    expect(render(true)).not.toContain("<form");
    expect(render(true)).not.toContain("action=");
  });

  /** The bundle boundary: a client file that reached for any of these would ship it. */
  it("imports only React, the action, and a button", async () => {
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync("components/billing-portal-button.tsx", "utf8");
    const imports = [...raw.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);

    expect(raw.startsWith('"use client";')).toBe(true);
    expect(imports).toEqual([
      "react",
      "@/app/dashboard/billing/portal-actions",
      "@/components/ui/button",
    ]);
  });

  it("holds no secret, no identifier, and no environment", async () => {
    const code = await source();

    for (const forbidden of [
      "process.env",
      "STRIPE_SECRET_KEY",
      "CHECKOUT_SANDBOX_USER_IDS",
      "userId",
      "email",
      "customerId",
      "subscriptionId",
      "returnUrl",
      "prisma",
      "server-only",
      "fetch(",
      "console.",
    ]) {
      expect(code, `holds ${forbidden}`).not.toContain(forbidden);
    }
  });
});

/**
 * The action module the button imports is a server reference, not server code.
 *
 * **It must carry the directive**, or the bundler would ship the orchestration
 * and the Stripe adapter to the browser along with it.
 */
describe("the action it calls", () => {
  it("is a server action module", async () => {
    const { readFileSync } = await import("node:fs");

    expect(
      readFileSync("app/dashboard/billing/portal-actions.ts", "utf8").startsWith(
        '"use server";',
      ),
    ).toBe(true);
  });

  it.each(["lib/billing/portal.ts", "lib/billing/providers/stripe-portal.ts"])(
    "%s is server-only",
    async (file) => {
      const { readFileSync } = await import("node:fs");

      expect(readFileSync(file, "utf8").startsWith('import "server-only";')).toBe(true);
    },
  );
});
