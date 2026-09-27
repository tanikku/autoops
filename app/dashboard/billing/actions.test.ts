import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The doorway, and only the doorway.
 *
 * **What is fixed here is what a request may supply and what leaves.** Whether a
 * paid account may buy, how the guardrail counts, what a retry asks the provider
 * for — none of that is tested here, because none of it is decided here. It is
 * settled in `lib/billing/checkout.test.ts` against the orchestration itself.
 *
 * **The orchestration is stood in for, so the boundary can be read.** Every test
 * below either checks what was handed to it, or what came back out of the
 * action — which is the whole of what this file adds.
 */

/**
 * Which files reach for the checkout action, and which are allowed to.
 *
 * **One caller, named.** For as long as the action was wired to nothing, the
 * answer was "none" and the check said so. Now exactly one control calls it, and
 * the check is worth more than it was: the thing that keeps a purchase behind a
 * single reviewed boundary is that a second component cannot quietly acquire the
 * ability to start one. So the list below is an allowlist, and any file not on it
 * that imports the action fails this.
 *
 * **Parsed rather than searched.** The first version of this asked whether the
 * text `billing/actions` appeared anywhere in a file, and a docblock saying the
 * action is deliberately *not* imported read as a caller — as did a sibling test
 * asserting the same absence. What the question is about is a module reference,
 * and a module reference is a syntax tree node rather than a substring.
 *
 * **TypeScript's own parser, which is already a dependency.** Nothing new is
 * installed to answer this; the compiler that typechecks the repository can also
 * say where an import is. A comment is not a node, so it cannot be mistaken for
 * one, and neither can a string sitting in an assertion.
 *
 * **Four shapes count, and they are the four that run code**: a static import
 * with bindings, a static import for its side effect alone, a dynamic `import()`
 * and a `require()`. Anything else that merely names the module — an assertion, a
 * fixture, a sentence — does not.
 */
const CHECKOUT_ACTION_PATH = "app/dashboard/billing/actions";

/**
 * The files that may start a checkout.
 *
 * **Exactly one, and it is a button.** Everything the purchase needs to decide is
 * decided on the server; what this file is allowed to do is ask. A second entry
 * here is a review question, not a formality.
 */
const APPROVED_CHECKOUT_ACTION_CALLERS = [
  "components/checkout-plan-button.tsx",
] as const;

/**
 * Whether a module specifier names the checkout action, from where it was written.
 *
 * **A relative specifier has to be resolved, not pattern-matched.** `./actions`
 * beside the billing page means this module; the same three characters beside the
 * settings page mean a different one entirely — so the importing file's own
 * directory is part of the question. The alias form is absolute and answers for
 * itself.
 */
function namesCheckoutAction(specifier: string, importerPath: string): boolean {
  const withoutExtension = specifier.replace(/\.[tj]sx?$/, "");

  if (withoutExtension.startsWith("@/")) {
    return withoutExtension.slice(2) === CHECKOUT_ACTION_PATH;
  }

  if (!withoutExtension.startsWith(".")) {
    // A bare package specifier cannot reach a file in this repository.
    return false;
  }

  const importerDirectory = importerPath.split("/").slice(0, -1).join("/");
  const resolved = posix.normalize(posix.join(importerDirectory, withoutExtension));

  return resolved === CHECKOUT_ACTION_PATH;
}

function referencesCheckoutAction(source: string, fileName: string): boolean {
  const tree = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  let found = false;

  const isCheckoutAction = (node: ts.Node | undefined): boolean =>
    node !== undefined &&
    ts.isStringLiteralLike(node) &&
    namesCheckoutAction(node.text, fileName);

  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }

    // `import x from "..."` and `import "..."` — the module specifier of an
    // import declaration is a string literal in both.
    if (ts.isImportDeclaration(node) && isCheckoutAction(node.moduleSpecifier)) {
      found = true;
      return;
    }

    // `export ... from "..."`, which re-exports and therefore also reaches it.
    if (
      ts.isExportDeclaration(node) &&
      isCheckoutAction(node.moduleSpecifier)
    ) {
      found = true;
      return;
    }

    // `import("...")` and `require("...")`. The first is a call whose expression
    // is the `import` keyword; the second an ordinary call to an identifier.
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isImportCall = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequireCall =
        ts.isIdentifier(callee) && callee.text === "require";

      if ((isImportCall || isRequireCall) && isCheckoutAction(node.arguments[0])) {
        found = true;
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(tree);

  return found;
}

/**
 * Every file that could render, and whether any of them imports the action.
 *
 * **Tracked and untracked both**, because the blind spot that let this through
 * was exactly that: `git ls-files` lists what is committed, so two files added in
 * the same change were invisible to their own check until the moment they were
 * committed — and the check then failed in CI rather than here.
 * `--cached --others --exclude-standard` asks for both while still honouring
 * `.gitignore`, so `node_modules`, `.next` and the generated client stay out.
 *
 * **Tests are not callers.** A file whose job is to assert that nothing imports
 * the action would otherwise be the thing that imports it.
 */
function findCheckoutActionCallers(): string[] {
  const listed = execSync(
    "git ls-files --cached --others --exclude-standard -- app components",
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);

  return listed
    .filter(
      (file) =>
        (file.endsWith(".ts") || file.endsWith(".tsx")) &&
        !file.endsWith(".test.ts") &&
        !file.endsWith(".test.tsx") &&
        // The action itself is not a caller of itself.
        !/billing\/actions\.tsx?$/.test(file),
    )
    .filter((file) => referencesCheckoutAction(readFileSync(file, "utf8"), file));
}

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  requireProvisionedUserId: vi.fn(),
  isUserProvisioningError: vi.fn(),
  isSandboxCheckoutEnabledForUser: vi.fn(),
  startCheckout: vi.fn(),
  createStripeCheckoutProvider: vi.fn(),
}));

// **Stood in for whole**, the way every other action test does it: importing
// the real module would pull in the auth library and, with it, a server runtime
// a test has no business starting.
vi.mock("@/lib/session", () => ({
  requireUserId: mocks.requireUserId,
  requireProvisionedUserId: mocks.requireProvisionedUserId,
  isUserProvisioningError: mocks.isUserProvisioningError,
}));
// **Stood in for so the gate can be both answers.** What the list means is settled
// in `lib/billing/checkout-sandbox.test.ts`; what matters here is which side of it
// a request lands on and what happens next.
vi.mock("@/lib/billing/checkout-sandbox-server", () => ({
  isSandboxCheckoutEnabledForUser: mocks.isSandboxCheckoutEnabledForUser,
}));
vi.mock("@/lib/billing/checkout", () => ({ startCheckout: mocks.startCheckout }));
vi.mock("@/lib/billing/providers/stripe-checkout", () => ({
  createStripeCheckoutProvider: mocks.createStripeCheckoutProvider,
}));

const { startCheckoutAction } = await import("@/app/dashboard/billing/actions");

const USER = "116614511017733764020";
const PROVIDER = { createSession: vi.fn(), readSession: vi.fn(), findLiveSubscription: vi.fn() };

const logs: string[] = [];

beforeEach(() => {
  mocks.requireUserId.mockReset().mockResolvedValue(USER);
  mocks.requireProvisionedUserId.mockReset().mockResolvedValue(USER);
  // Inside the rollout unless a test says otherwise: the tests that were written
  // before the gate existed are all about what an authorised request does.
  mocks.isSandboxCheckoutEnabledForUser.mockReset().mockReturnValue(true);
  // A rejection is a redirect unless a test says otherwise.
  mocks.isUserProvisioningError.mockReset().mockReturnValue(false);
  mocks.createStripeCheckoutProvider.mockReset().mockReturnValue(PROVIDER);
  mocks.startCheckout.mockReset().mockResolvedValue({
    outcome: "checkout-ready",
    attemptId: "attempt-1",
    sessionId: "cs_test_1",
    url: "https://pay.example.invalid/1",
    standing: "below-limit",
    resumed: false,
  });

  logs.length = 0;
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});

describe("who the checkout is for", () => {
  /** The account comes from the session. A caller cannot name one. */
  it("passes the authenticated account to the orchestration", async () => {
    await startCheckoutAction({ plan: "lite" });

    expect(mocks.startCheckout.mock.calls[0][0].userId).toBe(USER);
  });

  /**
   * **The row is provisioned before a checkout is begun.** A `CheckoutAttempt`
   * carries a foreign key to `User`, so the row has to exist first.
   */
  it("provisions the account row", async () => {
    await startCheckoutAction({ plan: "lite" });

    expect(mocks.requireProvisionedUserId).toHaveBeenCalledTimes(1);
  });

  /**
   * **A redirect has to be allowed to leave.** It travels as a thrown error, and
   * swallowing it would show a signed-out visitor a message on a page they are
   * not signed in to — the same distinction `updateTimezoneAction` makes.
   */
  it("lets a signed-out visitor be redirected", async () => {
    mocks.requireProvisionedUserId.mockRejectedValue(
      Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT" }),
    );

    await expect(startCheckoutAction({ plan: "lite" })).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(mocks.startCheckout).not.toHaveBeenCalled();
    expect(mocks.createStripeCheckoutProvider).not.toHaveBeenCalled();
  });

  /** The row could not be written. Not an authentication failure, and not a
   * reason to describe the database to anybody. */
  it("answers safely when the account row cannot be written", async () => {
    mocks.requireProvisionedUserId.mockRejectedValue(
      Object.assign(new Error("could not provision"), {
        name: "UserProvisioningError",
      }),
    );
    mocks.isUserProvisioningError.mockReturnValue(true);

    expect(await startCheckoutAction({ plan: "lite" })).toEqual({
      outcome: "unavailable",
    });
    expect(mocks.startCheckout).not.toHaveBeenCalled();
  });

  /** A caller's own `userId` is not a parameter and cannot become one. */
  it("ignores an account id somebody tried to send", async () => {
    await startCheckoutAction({
      plan: "lite",
      userId: "somebody-else",
    } as unknown as Parameters<typeof startCheckoutAction>[0]);

    expect(mocks.startCheckout.mock.calls[0][0].userId).toBe(USER);
  });
});

/**
 * The rollout gate, which is asked before anything happens.
 *
 * **The button being disabled is not what enforces this.** A server action is
 * callable by anybody with a session, whatever a page rendered, so the tests
 * below are about a request that got here anyway — and what they check is not the
 * answer it receives but that nothing happened on the way to it.
 */
describe("who may reach the checkout at all", () => {
  beforeEach(() => {
    mocks.isSandboxCheckoutEnabledForUser.mockReturnValue(false);
  });

  it("asks about the authenticated account", async () => {
    await startCheckoutAction({ plan: "lite" });

    expect(mocks.isSandboxCheckoutEnabledForUser).toHaveBeenCalledWith(USER);
  });

  it("starts no checkout for an account outside the rollout", async () => {
    await startCheckoutAction({ plan: "lite" });

    expect(mocks.startCheckout).not.toHaveBeenCalled();
  });

  it("builds no provider", async () => {
    await startCheckoutAction({ plan: "lite" });

    expect(mocks.createStripeCheckoutProvider).not.toHaveBeenCalled();
  });

  /**
   * **A refusal must not write the account row.** Provisioning is the only write
   * this file can cause, and somebody who may not buy has no reason to acquire a
   * row — so the authenticated id is read first and the provisioned one only
   * after the gate.
   */
  it("provisions nothing", async () => {
    await startCheckoutAction({ plan: "lite" });

    expect(mocks.requireProvisionedUserId).not.toHaveBeenCalled();
  });

  it("answers the same way a deployment that cannot sell does", async () => {
    await expect(startCheckoutAction({ plan: "lite" })).resolves.toEqual({
      outcome: "unavailable",
    });
  });

  /** Nothing in the answer says a list exists, let alone who is on it. */
  it("says nothing about why", async () => {
    const result = await startCheckoutAction({ plan: "lite" });

    expect(JSON.stringify(result)).not.toMatch(/sandbox|allow|rollout|enabled/i);
    expect(Object.keys(result)).toEqual(["outcome"]);
  });

  it.each(["lite", "standard", "pro"] as const)(
    "refuses %s the same way",
    async (plan) => {
      await expect(startCheckoutAction({ plan })).resolves.toEqual({
        outcome: "unavailable",
      });
      expect(mocks.startCheckout).not.toHaveBeenCalled();
    },
  );

  /** An acknowledgement is not a way past the gate. */
  it("is not opened by acknowledging the over-limit warning", async () => {
    await startCheckoutAction({ plan: "lite", overLimitAcknowledged: true });

    expect(mocks.startCheckout).not.toHaveBeenCalled();
  });

  /**
   * **Nothing a caller sends decides this.** The only account this action knows
   * is the one the session named, so an id in the payload cannot be the one the
   * gate is asked about.
   */
  it("cannot be aimed at another account", async () => {
    await startCheckoutAction({
      plan: "lite",
      userId: "999",
      email: "someone@example.invalid",
      sandbox: true,
      enabled: true,
    } as never);

    expect(mocks.isSandboxCheckoutEnabledForUser).toHaveBeenCalledWith(USER);
    expect(mocks.startCheckout).not.toHaveBeenCalled();
  });

  it("reads the gate before anything else can be asked", async () => {
    await startCheckoutAction({ plan: "lite" });

    expect(mocks.isSandboxCheckoutEnabledForUser).toHaveBeenCalledTimes(1);
    expect(mocks.requireUserId).toHaveBeenCalledTimes(1);
  });
});

/**
 * The account that passed the gate is the account that buys.
 *
 * Both session helpers read the same request, so these agree — and the one
 * outcome that must not be possible is a checkout for an account that was never
 * authorised, so it is checked rather than assumed.
 */
describe("when the two account ids disagree", () => {
  beforeEach(() => {
    mocks.requireProvisionedUserId.mockResolvedValue("999");
  });

  it("starts no checkout", async () => {
    await startCheckoutAction({ plan: "lite" });

    expect(mocks.startCheckout).not.toHaveBeenCalled();
  });

  it("answers unavailable", async () => {
    await expect(startCheckoutAction({ plan: "lite" })).resolves.toEqual({
      outcome: "unavailable",
    });
  });

  it("names no account in the log", async () => {
    await startCheckoutAction({ plan: "lite" });

    expect(logs.join(" ")).not.toContain(USER);
    expect(logs.join(" ")).not.toContain("999");
  });
});

describe("what a request may say", () => {
  it.each(["lite", "standard", "pro"])("accepts %s", async (plan) => {
    const result = await startCheckoutAction({
      plan: plan as "lite" | "standard" | "pro",
    });

    expect(result).toMatchObject({ outcome: "checkout-ready" });
    expect(mocks.startCheckout.mock.calls[0][0].plan).toBe(plan);
  });

  /**
   * **`trial` and `beta` are plans an account can be on, not ones it can buy.**
   * One begins by activating a worker; the other is granted by an operator.
   */
  it.each(["trial", "beta", "enterprise", "", "LITE", null, undefined, 1, {}])(
    "refuses %p without provisioning or calling anything",
    async (plan) => {
      const result = await startCheckoutAction({
        plan,
      } as unknown as Parameters<typeof startCheckoutAction>[0]);

      expect(result).toEqual({ outcome: "invalid-request" });
      expect(mocks.requireProvisionedUserId).not.toHaveBeenCalled();
      expect(mocks.startCheckout).not.toHaveBeenCalled();
      expect(mocks.createStripeCheckoutProvider).not.toHaveBeenCalled();
    },
  );

  it("accepts an acknowledgement that is absent", async () => {
    await startCheckoutAction({ plan: "lite" });

    expect(mocks.startCheckout.mock.calls[0][0].overLimitAcknowledged).toBe(false);
  });

  it.each([true, false])("accepts %p", async (value) => {
    await startCheckoutAction({ plan: "lite", overLimitAcknowledged: value });

    expect(mocks.startCheckout.mock.calls[0][0].overLimitAcknowledged).toBe(value);
  });

  /**
   * **Only an actual `true` acknowledges anything.** This is the flag between
   * somebody and a plan that allows fewer workers than they are running, so a
   * truthy string is refused rather than read as consent.
   */
  it.each(["true", "1", 1, {}, []])(
    "refuses an acknowledgement of %p",
    async (value) => {
      const result = await startCheckoutAction({
        plan: "lite",
        overLimitAcknowledged: value,
      } as unknown as Parameters<typeof startCheckoutAction>[0]);

      expect(result).toEqual({ outcome: "invalid-request" });
      expect(mocks.startCheckout).not.toHaveBeenCalled();
    },
  );

  /** Nothing about money, an address, or a provider object is a parameter. */
  it("hands the orchestration nothing a caller sent but the plan", async () => {
    await startCheckoutAction({
      plan: "lite",
      priceId: "price_someone_elses",
      customer: "cus_someone_elses",
      metadata: { koqentra_user_id: "somebody-else" },
      successUrl: "https://evil.example.invalid",
      cancelUrl: "https://evil.example.invalid",
      quantity: 99,
      amount: 1,
      currency: "usd",
      locale: "fr",
      provider: "not-stripe",
    } as unknown as Parameters<typeof startCheckoutAction>[0]);

    expect(Object.keys(mocks.startCheckout.mock.calls[0][0]).sort()).toEqual([
      "overLimitAcknowledged",
      "plan",
      "provider",
      "userId",
    ]);
    expect(mocks.startCheckout.mock.calls[0][0].provider).toBe(PROVIDER);
  });
});

describe("where the provider comes from", () => {
  /** A provider a caller could name would be a caller choosing who is told. */
  it("builds it on the server", async () => {
    await startCheckoutAction({ plan: "lite" });

    expect(mocks.createStripeCheckoutProvider).toHaveBeenCalledTimes(1);
    expect(mocks.createStripeCheckoutProvider).toHaveBeenCalledWith();
  });

  it("passes on its own unavailability without describing it", async () => {
    mocks.createStripeCheckoutProvider.mockReturnValue({
      unavailable: "no-secret-key",
    });
    mocks.startCheckout.mockResolvedValue({
      outcome: "unavailable",
      reason: "no-secret-key",
    });

    const result = await startCheckoutAction({ plan: "lite" });

    // The deployment's configuration is not something to explain to a browser.
    expect(result).toEqual({ outcome: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

describe("what comes back", () => {
  it("returns the address to send somebody to", async () => {
    const result = await startCheckoutAction({ plan: "lite" });

    expect(result).toEqual({
      outcome: "checkout-ready",
      url: "https://pay.example.invalid/1",
      standing: "below-limit",
    });
  });

  /**
   * **The session id stays on the server.** A page navigates; it does not
   * reconcile — and an id in a client payload is an id in a browser history.
   */
  it("keeps the provider's identifiers to itself", async () => {
    const result = await startCheckoutAction({ plan: "lite" });

    expect(result).not.toHaveProperty("sessionId");
    expect(result).not.toHaveProperty("attemptId");
    expect(result).not.toHaveProperty("resumed");
    expect(JSON.stringify(result)).not.toContain("cs_test_1");
    expect(JSON.stringify(result)).not.toContain("attempt-1");
  });

  /** A session with nowhere to go is not a session to report success for. */
  it("reports unavailable when the provider gave no address", async () => {
    mocks.startCheckout.mockResolvedValue({
      outcome: "checkout-ready",
      attemptId: "attempt-1",
      sessionId: "cs_test_1",
      url: null,
      standing: "below-limit",
      resumed: false,
    });

    expect(await startCheckoutAction({ plan: "lite" })).toEqual({
      outcome: "unavailable",
    });
  });

  it("carries the standing through, so a page can say what it means", async () => {
    for (const standing of ["below-limit", "at-limit", "over-limit"] as const) {
      mocks.startCheckout.mockResolvedValue({
        outcome: "checkout-ready",
        attemptId: "a",
        sessionId: "s",
        url: "https://pay.example.invalid/1",
        standing,
        resumed: false,
      });

      expect(await startCheckoutAction({ plan: "lite" })).toMatchObject({ standing });
    }
  });

  it("passes the over-limit question through with its numbers", async () => {
    mocks.startCheckout.mockResolvedValue({
      outcome: "over-limit-confirmation-required",
      activeWorkers: 3,
      activeWorkerLimit: 2,
    });

    expect(await startCheckoutAction({ plan: "lite" })).toEqual({
      outcome: "over-limit-confirmation-required",
      activeWorkers: 3,
      activeWorkerLimit: 2,
    });
  });

  it("passes a plan switch through with the plan in the way", async () => {
    mocks.startCheckout.mockResolvedValue({
      outcome: "plan-switch-required",
      currentPlan: "pro",
      attemptId: "attempt-1",
    });

    const result = await startCheckoutAction({ plan: "lite" });

    expect(result).toEqual({ outcome: "plan-switch-required", currentPlan: "pro" });
    expect(result).not.toHaveProperty("attemptId");
  });

  it.each([
    "already-subscribed",
    "payment-behind",
    "cancelling",
    "provider-subscription-live",
  ])("passes billing management through for %s", async (reason) => {
    mocks.startCheckout.mockResolvedValue({
      outcome: "billing-management-required",
      reason,
    });

    expect(await startCheckoutAction({ plan: "lite" })).toEqual({
      outcome: "billing-management-required",
      reason,
    });
  });

  it("passes payment-processing through without an attempt id", async () => {
    mocks.startCheckout.mockResolvedValue({
      outcome: "payment-processing",
      attemptId: "attempt-1",
    });

    expect(await startCheckoutAction({ plan: "lite" })).toEqual({
      outcome: "payment-processing",
    });
  });

  it("passes provider-verification-unavailable through", async () => {
    mocks.startCheckout.mockResolvedValue({
      outcome: "provider-verification-unavailable",
    });

    expect(await startCheckoutAction({ plan: "lite" })).toEqual({
      outcome: "provider-verification-unavailable",
    });
  });

  /** A deployment's own problem is not a sentence for whoever clicked Buy. */
  it.each([
    "inconsistent-subscription",
    "unreadable-entitlement",
    "no-return-url",
    "unreadable-attempt",
  ])("reduces malformed-config (%s) to unavailable", async (reason) => {
    mocks.startCheckout.mockResolvedValue({ outcome: "malformed-config", reason });

    const result = await startCheckoutAction({ plan: "lite" });

    expect(result).toEqual({ outcome: "unavailable" });
    expect(JSON.stringify(result)).not.toContain(reason);
  });

  /** Everything returned has to survive being sent to a browser. */
  it("returns something serialisable", async () => {
    const result = await startCheckoutAction({ plan: "lite" });

    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

describe("when something unexpected goes wrong", () => {
  it("answers safely", async () => {
    mocks.startCheckout.mockRejectedValue(new Error("everything broke"));

    expect(await startCheckoutAction({ plan: "lite" })).toEqual({
      outcome: "unavailable",
    });
  });

  it("says nothing of the cause to the caller", async () => {
    mocks.startCheckout.mockRejectedValue(
      new Error("Invalid API Key provided: sk_test_abc for cus_secret"),
    );

    const body = JSON.stringify(await startCheckoutAction({ plan: "lite" }));

    expect(body).not.toContain("sk_test");
    expect(body).not.toContain("cus_secret");
    expect(body).not.toContain("API Key");
  });

  /**
   * **A safety failure is logged by name and answered generically.** One attempt
   * holding two sessions is not something a person did, and not something a
   * browser can act on — but it is something somebody reading a log needs to
   * see.
   */
  it("logs the category and not the message", async () => {
    const conflict = Object.assign(new Error("cs_test_a vs cs_test_b"), {
      name: "CheckoutSessionConflict",
    });
    mocks.startCheckout.mockRejectedValue(conflict);

    const result = await startCheckoutAction({ plan: "lite" });

    expect(result).toEqual({ outcome: "unavailable" });

    const written = logs.join("\n");

    expect(written).toContain("CheckoutSessionConflict");
    expect(written).not.toContain("cs_test_a");
  });
});

describe("what this file is not", () => {
  it("is a server action", async () => {
    const { readFileSync } = await import("node:fs");

    expect(readFileSync("app/dashboard/billing/actions.ts", "utf8")).toMatch(
      /^"use server";/,
    );
  });

  /**
   * **No business logic, and the imports are how that is enforced.** Anything
   * that could decide who may buy would have to be imported to be used.
   */
  it("imports only a boundary's worth of things", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/dashboard/billing/actions.ts", "utf8");
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);

    expect(imports).toEqual([
      "@/lib/billing/checkout-attempt",
      "@/lib/billing/checkout",
      "@/lib/billing/checkout-sandbox-server",
      "@/lib/billing/providers/stripe-checkout",
      "@/lib/session",
    ]);
  });

  /** Every one of these lives in the orchestration, in one copy. */
  it("decides nothing the orchestration decides", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/dashboard/billing/actions.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of [
      "getPlanDefinition",
      "routine.count",
      "computeEntitlement",
      "subscription.findUnique",
      "beginCheckoutAttempt",
      "markCheckoutAttemptOpen",
      "closeCheckoutAttempt",
      "findLiveSubscription",
      "createSession",
      "idempotencyKey",
      "expires_at",
      "AUTH_URL",
      "prisma",
    ]) {
      expect(source, `decides ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("writes to no table", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/dashboard/billing/actions.ts", "utf8")
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
      for (const write of ["create", "update", "updateMany", "delete"]) {
        expect(source, `writes ${model}.${write}`).not.toContain(`${model}.${write}`);
      }
    }
  });

  it("does not reconcile, sweep, or navigate", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/dashboard/billing/actions.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of [
      "sweepBillingReconciliations",
      "runReconciliation",
      "recordProviderEventReceipt",
      "redirect(",
      "revalidatePath",
      "new Stripe",
      "stripe.checkout",
      "subscriptions.list",
    ]) {
      expect(source, `uses ${forbidden}`).not.toContain(forbidden);
    }
  });

  /**
   * **One approved caller, and no others.** The allowlist is exact: a page or a
   * component that starts reaching for the action fails here rather than in
   * review.
   */
  it("is called only from the approved boundary", () => {
    expect(findCheckoutActionCallers()).toEqual([
      ...APPROVED_CHECKOUT_ACTION_CALLERS,
    ]);
  });

  it("has exactly one caller", () => {
    expect(findCheckoutActionCallers()).toHaveLength(1);
  });

  /** The allowlist is not a wish: the file it names has to exist. */
  it("names a file that exists", async () => {
    const { existsSync } = await import("node:fs");

    for (const caller of APPROVED_CHECKOUT_ACTION_CALLERS) {
      expect(existsSync(caller), caller).toBe(true);
    }
  });
});

/**
 * What counts as reaching for the action, and what does not.
 *
 * **These exist because the first version of the check was a substring search.**
 * It read a docblock saying the action is deliberately not imported as a caller,
 * and it read the assertion above as one too — so CI refused a change whose
 * production code was correct. Each case below is one of those mistakes, fixed.
 *
 * **Parsed rather than matched**, so a mention in a comment or a string is not a
 * reference. The four positive cases are the four shapes that actually run
 * another module.
 */
describe("what counts as importing the checkout action", () => {
  const MODULE = "@/app/dashboard/billing/actions";

  /**
   * **The mistakes that broke CI, each as its own case.** A docblock explaining
   * that the action is not imported, an assertion proving the same thing, and an
   * ordinary string are all mentions rather than references — and a substring
   * search cannot tell them apart.
   */
  it.each([
    [
      "a docblock saying it is not imported",
      `/**
       * ${MODULE} is deliberately not imported here.
       */
export const a = 1;`,
    ],
    [
      "a line comment naming it",
      `// nothing imports ${MODULE}
export const a = 1;`,
    ],
    [
      "an assertion that nothing imports it",
      `expect(source).not.toContain(${JSON.stringify(MODULE)});`,
    ],
    ["an ordinary string", `const note = ${JSON.stringify(MODULE)};`],
    [
      "a fixture holding the path",
      `const fixtures = { action: ${JSON.stringify(MODULE)} };`,
    ],
    [
      "a similarly named module",
      `import { x } from "@/app/dashboard/billing/actions-helper";`,
    ],
  ])("does not count %s", (_label, source) => {
    expect(referencesCheckoutAction(source, "sample.ts")).toBe(false);
  });

  /** The four shapes that actually run the module, and a re-export. */
  it.each([
    ["a named static import", `import { startCheckoutAction } from "${MODULE}";`],
    ["a default static import", `import action from "${MODULE}";`],
    ["a side-effect import", `import "${MODULE}";`],
    ["a dynamic import", `const m = await import("${MODULE}");`],
    ["a require", `const m = require("${MODULE}");`],
    ["a re-export", `export { startCheckoutAction } from "${MODULE}";`],
  ])("counts %s", (_label, source) => {
    expect(referencesCheckoutAction(source, "sample.ts")).toBe(true);
  });

  /** Single quotes are a matter of formatting, not of meaning. */
  it("counts an import written with single quotes", () => {
    const source = 'import { startCheckoutAction } from \'@/app/dashboard/billing/actions\';';

    expect(referencesCheckoutAction(source, "sample.ts")).toBe(true);
  });

  /**
   * **A relative specifier is resolved from where it was written.** `./actions`
   * beside the billing page is this module; beside the settings page it is a
   * different one, and reading it as the same would refuse a change to a screen
   * that has nothing to do with buying.
   */
  it.each([
    ["./actions", "app/dashboard/billing/page.tsx"],
    ["../billing/actions", "app/dashboard/settings/page.tsx"],
    ["@/app/dashboard/billing/actions", "components/plan-cards.tsx"],
  ])("counts %s written in %s", (specifier, importer) => {
    const source = `import { startCheckoutAction } from "${specifier}";`;

    expect(referencesCheckoutAction(source, importer)).toBe(true);
  });

  /** Another module's own `actions.ts` is not this one. */
  it.each([
    ["./actions", "app/dashboard/settings/page.tsx"],
    ["./actions", "app/dashboard/page.tsx"],
    ["@/app/dashboard/settings/actions", "app/dashboard/billing/page.tsx"],
  ])("does not count %s written in %s", (specifier, importer) => {
    const source = `import { updateTimezoneAction } from "${specifier}";`;

    expect(referencesCheckoutAction(source, importer)).toBe(false);
  });

  /** JSX has to parse, or a page component would be unreadable to the check. */
  it("parses a component that imports it", () => {
    const source = `import { startCheckoutAction } from "${MODULE}";
export function Buy() {
  return <button onClick={() => startCheckoutAction({ plan: "lite" })}>Buy</button>;
}`;

    expect(referencesCheckoutAction(source, "buy.tsx")).toBe(true);
  });
});

/**
 * Which files the check looks at.
 *
 * **Untracked ones too, which is the other half of the bug.** `git ls-files`
 * lists what is committed, so the two files added alongside this check were
 * invisible to it until the commit that made them visible — and the failure then
 * landed in CI instead of here.
 */
describe("which files the check considers", () => {
  it("lists files git has not been told about yet", async () => {
    const { execSync } = await import("node:child_process");
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    // **Written outside the repository.** A fixture inside it would be a file
    // the repository now carries, which is what this check exists to notice.
    const scratch = mkdtempSync(join(tmpdir(), "caller-scan-"));

    try {
      execSync("git init --quiet", { cwd: scratch });
      writeFileSync(join(scratch, "tracked.tsx"), "export const a = 1;");
      execSync("git add tracked.tsx", { cwd: scratch });
      writeFileSync(join(scratch, "untracked.tsx"), "export const b = 2;");

      const listed = execSync(
        "git ls-files --cached --others --exclude-standard",
        { cwd: scratch, encoding: "utf8" },
      );

      expect(listed).toContain("tracked.tsx");
      expect(listed).toContain("untracked.tsx");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  /** A test asserting the absence must not be the thing that breaks it. */
  it("leaves test files out", () => {
    const callers = findCheckoutActionCallers();

    expect(callers.filter((file) => file.includes(".test."))).toEqual([]);
  });
});
