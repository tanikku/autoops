import { describe, expect, it } from "vitest";
import {
  SANDBOX_CHECKOUT_USER_IDS_ENV,
  isSandboxCheckoutEnabledForUser,
} from "@/lib/billing/checkout-sandbox-server";

/**
 * Where the rollout list is read from, and what an absent one means.
 *
 * **What the list means is settled next door**, in `checkout-sandbox.test.ts`.
 * What is fixed here is the variable it comes out of, that it is read on every
 * call, and that nothing but a boolean leaves.
 *
 * The ids are invented, for the same reason they are invented there.
 */

const ACCOUNT = "100000000000000000001";
const OTHER = "100000000000000000002";

/**
 * A deployment's environment, with or without the variable.
 *
 * Cast the way `stripe-runtime.test.ts` casts: `ProcessEnv` insists on
 * `NODE_ENV`, and a test describing two variables should not have to supply a
 * third it is not about.
 */
const env = (value?: string): NodeJS.ProcessEnv =>
  (value === undefined
    ? {}
    : { [SANDBOX_CHECKOUT_USER_IDS_ENV]: value }) as unknown as NodeJS.ProcessEnv;

describe("which variable is read", () => {
  it("is named once and used", () => {
    expect(SANDBOX_CHECKOUT_USER_IDS_ENV).toBe("CHECKOUT_SANDBOX_USER_IDS");
  });

  it("ignores a variable of another name", () => {
    expect(
      isSandboxCheckoutEnabledForUser(ACCOUNT, {
        CHECKOUT_SANDBOX_USERS: ACCOUNT,
        SANDBOX_USER_IDS: ACCOUNT,
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});

describe("fail closed", () => {
  it("refuses when the variable is absent", () => {
    expect(isSandboxCheckoutEnabledForUser(ACCOUNT, env())).toBe(false);
  });

  it.each(["", " ", ",", " , , "])("refuses when it is %p", (value) => {
    expect(isSandboxCheckoutEnabledForUser(ACCOUNT, env(value))).toBe(false);
  });

  /** An empty environment is what a deployment that forgot looks like. */
  it("refuses against an empty environment", () => {
    expect(
      isSandboxCheckoutEnabledForUser(ACCOUNT, {} as unknown as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});

describe("who it lets through", () => {
  it("allows a listed account", () => {
    expect(isSandboxCheckoutEnabledForUser(ACCOUNT, env(ACCOUNT))).toBe(true);
  });

  it("refuses one that is not listed", () => {
    expect(isSandboxCheckoutEnabledForUser(OTHER, env(ACCOUNT))).toBe(false);
  });

  it("allows each of several", () => {
    const configured = env(`${ACCOUNT}, ${OTHER}`);

    expect(isSandboxCheckoutEnabledForUser(ACCOUNT, configured)).toBe(true);
    expect(isSandboxCheckoutEnabledForUser(OTHER, configured)).toBe(true);
  });

  it("refuses a substring of a listed id", () => {
    expect(isSandboxCheckoutEnabledForUser("10000000000000000000", env(ACCOUNT))).toBe(
      false,
    );
  });

  it("answers a boolean and nothing else", () => {
    expect(isSandboxCheckoutEnabledForUser(ACCOUNT, env(ACCOUNT))).toBeTypeOf(
      "boolean",
    );
    expect(isSandboxCheckoutEnabledForUser(ACCOUNT, env())).toBeTypeOf("boolean");
  });
});

/**
 * **Read on use, not on import.** The point of this switch is being able to close
 * it: unsetting the variable has to take effect on the next request rather than on
 * the next restart, which a value captured at module load would not do.
 */
describe("when the list is read", () => {
  it("sees a list that was added after the module loaded", () => {
    expect(isSandboxCheckoutEnabledForUser(ACCOUNT, env())).toBe(false);
    expect(isSandboxCheckoutEnabledForUser(ACCOUNT, env(ACCOUNT))).toBe(true);
  });

  it("sees a list that was taken away again", () => {
    expect(isSandboxCheckoutEnabledForUser(ACCOUNT, env(ACCOUNT))).toBe(true);
    expect(isSandboxCheckoutEnabledForUser(ACCOUNT, env())).toBe(false);
  });

  it("captures nothing at module scope", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      "lib/billing/checkout-sandbox-server.ts",
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    // The only `process.env` is the default argument, inside the function.
    expect(source.match(/process\.env/g) ?? []).toHaveLength(1);
    expect(source).not.toMatch(/^const \w+ = parseSandboxCheckoutUserIds/m);
  });
});

describe("what this module is not", () => {
  it("runs only on the server", async () => {
    const { readFileSync } = await import("node:fs");

    expect(
      readFileSync("lib/billing/checkout-sandbox-server.ts", "utf8"),
    ).toContain('import "server-only"');
  });

  it("hard-codes no account", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      "lib/billing/checkout-sandbox-server.ts",
      "utf8",
    );

    expect(source).not.toMatch(/["'`]\d{10,}["'`]/);
  });

  it("touches no database and no provider", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      "lib/billing/checkout-sandbox-server.ts",
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of ["prisma", "Stripe", "fetch(", "startCheckout"]) {
      expect(source, `reaches for ${forbidden}`).not.toContain(forbidden);
    }
  });
});
