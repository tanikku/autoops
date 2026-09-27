import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The doorway to the billing portal, and only the doorway.
 *
 * **What is fixed here is that nothing a request carries is used.** Who has
 * something to manage and what the provider is asked is
 * `lib/billing/portal.test.ts`; this file checks who is asking, which side of
 * the rollout switch they are on, and what may leave for a browser.
 */

/**
 * Which files reach for the portal action.
 *
 * **The same parsed check as the checkout action's**, in
 * `actions.test.ts`: a module reference is a syntax tree node, so a comment or
 * an assertion naming the module is not mistaken for one.
 */
const PORTAL_ACTION_PATH = "app/dashboard/billing/portal-actions";

/** Exactly one, and it is a button. */
const APPROVED_PORTAL_ACTION_CALLERS = [
  "components/billing-portal-button.tsx",
] as const;

function namesPortalAction(specifier: string, importerPath: string): boolean {
  const withoutExtension = specifier.replace(/\.[tj]sx?$/, "");

  if (withoutExtension.startsWith("@/")) {
    return withoutExtension.slice(2) === PORTAL_ACTION_PATH;
  }

  if (!withoutExtension.startsWith(".")) {
    return false;
  }

  const importerDirectory = importerPath.split("/").slice(0, -1).join("/");

  return (
    posix.normalize(posix.join(importerDirectory, withoutExtension)) ===
    PORTAL_ACTION_PATH
  );
}

function referencesPortalAction(source: string, fileName: string): boolean {
  const tree = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  let found = false;

  const isPortalAction = (node: ts.Node | undefined): boolean =>
    node !== undefined &&
    ts.isStringLiteralLike(node) &&
    namesPortalAction(node.text, fileName);

  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }

    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      isPortalAction(node.moduleSpecifier)
    ) {
      found = true;
      return;
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isImportCall = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequireCall = ts.isIdentifier(callee) && callee.text === "require";

      if ((isImportCall || isRequireCall) && isPortalAction(node.arguments[0])) {
        found = true;
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(tree);

  return found;
}

/** Tracked and untracked both, as the checkout check learned to. */
function findPortalActionCallers(): string[] {
  return execSync(
    "git ls-files --cached --others --exclude-standard -- app components",
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .filter(
      (file) =>
        (file.endsWith(".ts") || file.endsWith(".tsx")) &&
        !file.endsWith(".test.ts") &&
        !file.endsWith(".test.tsx") &&
        !/billing\/portal-actions\.tsx?$/.test(file),
    )
    .filter((file) => referencesPortalAction(readFileSync(file, "utf8"), file));
}

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  requireProvisionedUserId: vi.fn(),
  isSandboxCheckoutEnabledForUser: vi.fn(),
  openBillingPortal: vi.fn(),
  createStripeBillingPortalProvider: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  requireUserId: mocks.requireUserId,
  requireProvisionedUserId: mocks.requireProvisionedUserId,
}));
vi.mock("@/lib/billing/checkout-sandbox-server", () => ({
  isSandboxCheckoutEnabledForUser: mocks.isSandboxCheckoutEnabledForUser,
}));
vi.mock("@/lib/billing/portal", () => ({
  openBillingPortal: mocks.openBillingPortal,
}));
vi.mock("@/lib/billing/providers/stripe-portal", () => ({
  createStripeBillingPortalProvider: mocks.createStripeBillingPortalProvider,
}));

const { openBillingPortalAction } = await import(
  "@/app/dashboard/billing/portal-actions"
);

const USER = "116614511017733764020";
const PROVIDER = { createPortalSession: vi.fn() };
const PORTAL_URL = "https://billing.stripe.com/p/session/test_abc";

const logs: string[] = [];

/** Calls the action the way a caller who tried to send something would. */
const callWith = (...args: unknown[]) =>
  (openBillingPortalAction as (...a: unknown[]) => ReturnType<typeof openBillingPortalAction>)(
    ...args,
  );

beforeEach(() => {
  mocks.requireUserId.mockReset().mockResolvedValue(USER);
  mocks.requireProvisionedUserId.mockReset().mockResolvedValue(USER);
  mocks.isSandboxCheckoutEnabledForUser.mockReset().mockReturnValue(true);
  mocks.createStripeBillingPortalProvider.mockReset().mockReturnValue(PROVIDER);
  mocks.openBillingPortal
    .mockReset()
    .mockResolvedValue({ outcome: "portal-ready", url: PORTAL_URL });

  logs.length = 0;
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});

describe("what a caller may send", () => {
  it("takes no arguments", () => {
    expect(openBillingPortalAction.length).toBe(0);
  });

  it("opens the portal for the signed-in account", async () => {
    expect(await openBillingPortalAction()).toEqual({
      outcome: "portal-ready",
      url: PORTAL_URL,
    });
    expect(mocks.openBillingPortal).toHaveBeenCalledTimes(1);
    expect(mocks.openBillingPortal.mock.calls[0][0]).toEqual({
      userId: USER,
      provider: PROVIDER,
    });
  });

  /** Anything sent is ignored: the orchestration hears only the session. */
  it.each([
    ["an account id", { userId: "somebody-else" }],
    ["an email", { email: "someone@example.invalid" }],
    ["a customer", { customerId: "cus_somebody_else" }],
    ["a subscription", { subscriptionId: "sub_somebody_else" }],
    ["a return address", { returnUrl: "https://evil.example" }],
    ["a provider", { provider: "other" }],
    ["a plan and a state", { plan: "pro", state: "active" }],
  ])("ignores %s somebody tried to send", async (_label, payload) => {
    await callWith(payload);

    expect(mocks.openBillingPortal.mock.calls[0][0]).toEqual({
      userId: USER,
      provider: PROVIDER,
    });
  });

  it("builds the provider from the server's own environment", async () => {
    await callWith({ env: { STRIPE_SECRET_KEY: "sk_live_from_caller" } });

    expect(mocks.createStripeBillingPortalProvider).toHaveBeenCalledWith();
  });
});

describe("who is asking", () => {
  it("lets a signed-out visitor be redirected", async () => {
    mocks.requireUserId.mockRejectedValue(
      Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT" }),
    );

    await expect(openBillingPortalAction()).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.openBillingPortal).not.toHaveBeenCalled();
    expect(mocks.createStripeBillingPortalProvider).not.toHaveBeenCalled();
  });

  /** Opening a portal writes no row, so none is provisioned. */
  it("provisions nothing", async () => {
    await openBillingPortalAction();

    expect(mocks.requireProvisionedUserId).not.toHaveBeenCalled();
  });
});

describe("who may reach the portal at all", () => {
  beforeEach(() => {
    mocks.isSandboxCheckoutEnabledForUser.mockReturnValue(false);
  });

  it("asks about the authenticated account", async () => {
    await openBillingPortalAction();

    expect(mocks.isSandboxCheckoutEnabledForUser).toHaveBeenCalledWith(USER);
  });

  it("answers an account outside the rollout as unavailable, and does nothing", async () => {
    expect(await openBillingPortalAction()).toEqual({ outcome: "unavailable" });
    expect(mocks.createStripeBillingPortalProvider).not.toHaveBeenCalled();
    expect(mocks.openBillingPortal).not.toHaveBeenCalled();
  });
});

/**
 * The rollout list itself, read for real.
 *
 * **Fail closed when it is unset.** The gate is stood in for above so the
 * action can be driven to both answers; here it is the real helper, reading the
 * real variable, so an unset list is proven to refuse.
 */
describe("the rollout list, read for real", () => {
  it("refuses everybody when the list is unset, and only lets the named account in", async () => {
    const actual = await vi.importActual<
      typeof import("@/lib/billing/checkout-sandbox-server")
    >("@/lib/billing/checkout-sandbox-server");

    expect(actual.isSandboxCheckoutEnabledForUser(USER, {} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      actual.isSandboxCheckoutEnabledForUser(USER, {
        CHECKOUT_SANDBOX_USER_IDS: "",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      actual.isSandboxCheckoutEnabledForUser(USER, {
        CHECKOUT_SANDBOX_USER_IDS: USER,
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      actual.isSandboxCheckoutEnabledForUser("somebody-else", {
        CHECKOUT_SANDBOX_USER_IDS: USER,
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});

describe("what leaves for a browser", () => {
  it("passes on that there is nothing to manage", async () => {
    mocks.openBillingPortal.mockResolvedValue({ outcome: "not-eligible" });

    expect(await openBillingPortalAction()).toEqual({ outcome: "not-eligible" });
  });

  it.each([
    "provider-unconfigured",
    "no-return-url",
    "no-customer",
    "provider-failed",
    "untrusted-url",
  ])("says only unavailable for %s, and logs the reason alone", async (reason) => {
    mocks.openBillingPortal.mockResolvedValue({ outcome: "unavailable", reason });

    expect(await openBillingPortalAction()).toEqual({ outcome: "unavailable" });
    expect(logs).toEqual([`[portal] could not open the billing portal — ${reason}`]);
  });

  it("drops anything the orchestration's answer carries besides the address", async () => {
    mocks.openBillingPortal.mockResolvedValue({
      outcome: "portal-ready",
      url: PORTAL_URL,
      customerId: "cus_existing",
    });

    expect(await openBillingPortalAction()).toEqual({
      outcome: "portal-ready",
      url: PORTAL_URL,
    });
  });

  it("says nothing of an unexpected failure's cause", async () => {
    mocks.openBillingPortal.mockRejectedValue(
      new Error("No such customer: 'cus_existing'; key sk_test_secret"),
    );

    const result = await openBillingPortalAction();

    expect(result).toEqual({ outcome: "unavailable" });
    expect(logs).toEqual(["[portal] could not open the billing portal — Error"]);

    for (const line of [...logs, JSON.stringify(result)]) {
      expect(line).not.toContain("cus_");
      expect(line).not.toContain("sk_");
      expect(line).not.toContain(USER);
    }
  });

  it("never logs the portal address", async () => {
    await openBillingPortalAction();

    expect(logs.join("\n")).not.toContain("billing.stripe.com");
  });
});

describe("what the action does not do", () => {
  it("writes, reconciles, and navigates nothing", () => {
    const source = readFileSync("app/dashboard/billing/portal-actions.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of [
      "prisma",
      "requireProvisionedUserId",
      "sweepBillingReconciliations",
      "runReconciliation",
      "redirect(",
      "revalidatePath",
      "new Stripe",
      "subscriptions.",
      "process.env",
    ]) {
      expect(source, `uses ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("is called only from the approved boundary", () => {
    expect(findPortalActionCallers()).toEqual([...APPROVED_PORTAL_ACTION_CALLERS]);
  });

  it("does not count a mention as a caller", () => {
    expect(
      referencesPortalAction(
        `// nothing imports @/app/dashboard/billing/portal-actions
const note = "@/app/dashboard/billing/portal-actions";`,
        "sample.ts",
      ),
    ).toBe(false);
    expect(
      referencesPortalAction(
        `import { openBillingPortalAction } from "./portal-actions";`,
        "app/dashboard/billing/page.tsx",
      ),
    ).toBe(true);
    expect(
      referencesPortalAction(
        `import { x } from "./portal-actions";`,
        "app/dashboard/settings/page.tsx",
      ),
    ).toBe(false);
  });
});
