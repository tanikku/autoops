import { describe, expect, it } from "vitest";
import { isBetaSignInAllowed, parseBetaAllowlist } from "@/lib/beta-access";

/**
 * Who gets in while the beta is invite-only.
 *
 * Two rules carry most of this. **An empty list refuses everyone** — the whole
 * point is to keep uninvited people out of production, so a variable nobody set
 * has to fail in that direction. And **the comparison is literal**: providers
 * disagree about which addresses are "the same", and matching more than what is
 * written would let in somebody nobody listed.
 *
 * Every address here is at `example.com`. None of them belongs to anyone.
 */

const ALLOWED = "invited@example.com";

function allowlist(...entries: string[]) {
  return new Set(entries);
}

function verified(email: string | null | undefined) {
  return { email, email_verified: true };
}

describe("parseBetaAllowlist", () => {
  it("reads a single address", () => {
    expect(parseBetaAllowlist(ALLOWED)).toEqual(allowlist(ALLOWED));
  });

  it("reads several", () => {
    expect(parseBetaAllowlist("a@example.com,b@example.com")).toEqual(
      allowlist("a@example.com", "b@example.com"),
    );
  });

  it.each([
    ["nothing configured", undefined],
    ["an empty string", ""],
    ["only whitespace", "   "],
    ["only separators", ",,,"],
    ["separators and whitespace", " , , "],
  ])("gives back an empty list for %s", (_label, value) => {
    expect(parseBetaAllowlist(value)).toEqual(allowlist());
  });

  it("ignores the space around each address", () => {
    expect(parseBetaAllowlist("  a@example.com ,  b@example.com  ")).toEqual(
      allowlist("a@example.com", "b@example.com"),
    );
  });

  it("settles the case of what was configured", () => {
    expect(parseBetaAllowlist("Invited@Example.COM")).toEqual(
      allowlist(ALLOWED),
    );
  });

  /**
   * A trailing comma is the likely way this happens, and `""` matching an
   * address would be the worst bug a refusal could have.
   */
  it("drops entries that are not addresses", () => {
    expect(parseBetaAllowlist("a@example.com,,b@example.com,")).toEqual(
      allowlist("a@example.com", "b@example.com"),
    );
  });

  it("counts the same address once however it was written", () => {
    expect(parseBetaAllowlist("a@example.com, A@EXAMPLE.COM").size).toBe(1);
  });
});

describe("isBetaSignInAllowed", () => {
  it("lets an invited address in", () => {
    expect(isBetaSignInAllowed(verified(ALLOWED), allowlist(ALLOWED))).toBe(
      true,
    );
  });

  it("turns away an address nobody listed", () => {
    expect(
      isBetaSignInAllowed(verified("stranger@example.com"), allowlist(ALLOWED)),
    ).toBe(false);
  });

  /** The answer a forgotten environment variable has to produce. */
  it("turns everyone away when the list is empty", () => {
    expect(isBetaSignInAllowed(verified(ALLOWED), allowlist())).toBe(false);
  });

  it.each([
    ["there is no profile", undefined],
    ["the address is missing", { email: undefined, email_verified: true }],
    ["the address is null", { email: null, email_verified: true }],
    [
      "the address is not verified",
      { email: ALLOWED, email_verified: false },
    ],
    [
      "verification is not reported",
      { email: ALLOWED, email_verified: undefined },
    ],
    [
      "verification is reported as null",
      { email: ALLOWED, email_verified: null },
    ],
  ])("turns the visitor away when %s", (_label, profile) => {
    expect(isBetaSignInAllowed(profile, allowlist(ALLOWED))).toBe(false);
  });

  it("settles the case and space of what the provider returned", () => {
    expect(
      isBetaSignInAllowed(verified("  Invited@Example.COM  "), allowlist(ALLOWED)),
    ).toBe(true);
  });
});

/**
 * The comparison is literal in both directions.
 *
 * Gmail ignores dots and several providers treat `+tag` as an alias, but
 * deciding that here would be guessing on the provider's behalf — and guessing
 * wide lets in an address nobody wrote down.
 */
describe("isBetaSignInAllowed — addresses that only look the same", () => {
  it.each([
    ["a dot the list does not have", "first.last@example.com", "firstlast@example.com"],
    ["a dot the list has", "firstlast@example.com", "first.last@example.com"],
    ["a tag the list does not have", "invited+beta@example.com", ALLOWED],
    ["a tag the list has", ALLOWED, "invited+beta@example.com"],
  ])("refuses %s", (_label, email, listed) => {
    expect(isBetaSignInAllowed(verified(email), allowlist(listed))).toBe(false);
  });
});
