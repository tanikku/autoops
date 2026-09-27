import { describe, expect, it } from "vitest";
import {
  isSandboxCheckoutAllowed,
  parseSandboxCheckoutUserIds,
} from "@/lib/billing/checkout-sandbox";

/**
 * Who may start a checkout while the purchase path is being proved.
 *
 * **The ids below are invented.** The account the rollout is actually for is
 * named in one place — a variable on the deployment — and writing it into a test
 * would put it in the repository, where it would outlive the rollout and be
 * copied by the next person who needed an example.
 *
 * **Every test that matters here is a refusal.** This function's job is to keep a
 * sandbox purchase away from real accounts, so the cases worth fixing are the ones
 * where it might wrongly say yes.
 */

const ACCOUNT = "100000000000000000001";
const OTHER = "100000000000000000002";

describe("reading the configured list", () => {
  it.each([undefined, "", " ", ",", " , , "])(
    "finds nothing in %p",
    (value) => {
      expect(parseSandboxCheckoutUserIds(value)).toEqual([]);
    },
  );

  it("finds one id", () => {
    expect(parseSandboxCheckoutUserIds(ACCOUNT)).toEqual([ACCOUNT]);
  });

  it("finds several", () => {
    expect(parseSandboxCheckoutUserIds(`${ACCOUNT},${OTHER}`)).toEqual([
      ACCOUNT,
      OTHER,
    ]);
  });

  /** Lists get pasted with spaces and newlines in them. */
  it("ignores the space around each one", () => {
    expect(
      parseSandboxCheckoutUserIds(`  ${ACCOUNT} ,\n  ${OTHER}  `),
    ).toEqual([ACCOUNT, OTHER]);
  });

  it("drops the gaps a trailing comma leaves", () => {
    expect(parseSandboxCheckoutUserIds(`${ACCOUNT},,${OTHER},`)).toEqual([
      ACCOUNT,
      OTHER,
    ]);
  });

  /** The same account written twice is one account. */
  it("keeps one of each", () => {
    expect(
      parseSandboxCheckoutUserIds(`${ACCOUNT},${ACCOUNT}, ${ACCOUNT} `),
    ).toEqual([ACCOUNT]);
  });

  /**
   * **No case folding.** The id is whatever the provider issued; deciding that
   * two spellings of it are the same account would be inventing an equivalence
   * nobody stated.
   */
  it("does not treat a differently-cased id as the same one", () => {
    expect(parseSandboxCheckoutUserIds("abcDEF")).toEqual(["abcDEF"]);
  });
});

describe("who is allowed", () => {
  /** An unset variable refuses everyone. This is the whole of the fail-closed. */
  it("refuses everyone when nothing is configured", () => {
    expect(
      isSandboxCheckoutAllowed(ACCOUNT, parseSandboxCheckoutUserIds(undefined)),
    ).toBe(false);
  });

  it.each(["", " ", ",", " , "])("refuses everyone when configured as %p", (value) => {
    expect(
      isSandboxCheckoutAllowed(ACCOUNT, parseSandboxCheckoutUserIds(value)),
    ).toBe(false);
  });

  it("allows the account that is listed", () => {
    expect(
      isSandboxCheckoutAllowed(ACCOUNT, parseSandboxCheckoutUserIds(ACCOUNT)),
    ).toBe(true);
  });

  it("refuses an account that is not", () => {
    expect(
      isSandboxCheckoutAllowed(OTHER, parseSandboxCheckoutUserIds(ACCOUNT)),
    ).toBe(false);
  });

  it("allows each of several", () => {
    const allowed = parseSandboxCheckoutUserIds(`${ACCOUNT}, ${OTHER}`);

    expect(isSandboxCheckoutAllowed(ACCOUNT, allowed)).toBe(true);
    expect(isSandboxCheckoutAllowed(OTHER, allowed)).toBe(true);
    expect(isSandboxCheckoutAllowed("100000000000000000003", allowed)).toBe(
      false,
    );
  });

  it("allows an id that was written with space around it", () => {
    expect(
      isSandboxCheckoutAllowed(
        ACCOUNT,
        parseSandboxCheckoutUserIds(`  ${ACCOUNT}  `),
      ),
    ).toBe(true);
  });

  /**
   * **Exact, not contained.** These ids are consecutive digits, so a prefix test
   * would let a short id stand for a long one — and a list holding one account
   * would admit any account whose id contained it.
   */
  it.each([
    ["a prefix of the listed id", "10000000000000000000"],
    ["the listed id with more after it", `${ACCOUNT}9`],
    ["the listed id with more before it", `9${ACCOUNT}`],
    ["a middle slice of it", "0000000000000000000"],
  ])("refuses %s", (_label, userId) => {
    expect(
      isSandboxCheckoutAllowed(userId, parseSandboxCheckoutUserIds(ACCOUNT)),
    ).toBe(false);
  });

  /** And the other way round: a listed prefix does not admit the longer id. */
  it("refuses an account whose id merely starts with a listed one", () => {
    expect(
      isSandboxCheckoutAllowed(
        `${ACCOUNT}0`,
        parseSandboxCheckoutUserIds(`${ACCOUNT},${OTHER}`),
      ),
    ).toBe(false);
  });

  it("refuses an empty account id", () => {
    expect(
      isSandboxCheckoutAllowed("", parseSandboxCheckoutUserIds(ACCOUNT)),
    ).toBe(false);
  });

  /** Nothing is configured and nobody is signed in: still no. */
  it("refuses an empty account id against an empty list", () => {
    expect(isSandboxCheckoutAllowed("", [])).toBe(false);
  });

  it("refuses a differently-cased spelling of a listed id", () => {
    expect(
      isSandboxCheckoutAllowed("ABCdef", parseSandboxCheckoutUserIds("abcDEF")),
    ).toBe(false);
  });
});

describe("what this module is not", () => {
  it("reads no environment, database, or request", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/checkout-sandbox.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of [
      "process.env",
      "prisma",
      "auth(",
      "headers(",
      "cookies(",
      "fetch(",
      "import",
    ]) {
      expect(source, `reaches for ${forbidden}`).not.toContain(forbidden);
    }
  });

  /** No account id is written down here, and none may be. */
  it("hard-codes no account", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/billing/checkout-sandbox.ts", "utf8");

    expect(source).not.toMatch(/["'`]\d{10,}["'`]/);
  });
});
