import { describe, expect, it, vi } from "vitest";
import {
  readAccessMode,
  readPublicBetaSignup,
  SIGNUP_CLOSED_PATH,
  SIGNUP_FULL_PATH,
} from "@/lib/beta-access";
import { decideSignIn } from "@/lib/public-beta-admission";

/**
 * Who may sign in, decided in a fixed order in either mode.
 *
 * The database is behind two functions here — whether a subject is already
 * known, and the locked admission — so the order can be fixed exactly. That the
 * admission itself is race-safe is the integration suite's job.
 */

const VERIFIED = { email: "new@example.com", email_verified: true };
const OPEN = { enabled: true, limit: 10 };

function deps(overrides: { known?: boolean; admit?: "admitted" | "full" } = {}) {
  return {
    isKnown: vi.fn(async () => overrides.known ?? false),
    admit: vi.fn(async () => overrides.admit ?? "admitted"),
  };
}

function decide(
  input: Partial<Parameters<typeof decideSignIn>[0]>,
  d: ReturnType<typeof deps>,
) {
  return decideSignIn(
    {
      mode: "public-beta",
      profile: VERIFIED,
      userId: "google-sub-new",
      allowlist: new Set(),
      signup: OPEN,
      ...input,
    },
    d,
  );
}

describe("reading the mode", () => {
  it("opens Public Beta only for the exact word", () => {
    expect(readAccessMode("public-beta")).toBe("public-beta");
    expect(readAccessMode(" public-beta ")).toBe("public-beta");
  });

  it.each([undefined, "", "public_beta", "Public-Beta", "public", "open"])(
    "keeps Closed Beta for %o",
    (value) => {
      expect(readAccessMode(value)).toBe("closed-beta");
    },
  );
});

describe("reading the signup switch and cap", () => {
  it("reads an open signup of ten", () => {
    expect(
      readPublicBetaSignup({ PUBLIC_BETA_SIGNUP_ENABLED: "true", PUBLIC_BETA_SIGNUP_LIMIT: "10" }),
    ).toEqual({ enabled: true, limit: 10 });
  });

  it.each([undefined, "", "TRUE", "yes", "1", "false"])("keeps signup closed for %o", (value) => {
    expect(readPublicBetaSignup({ PUBLIC_BETA_SIGNUP_ENABLED: value }).enabled).toBe(false);
  });

  it.each([undefined, "", "-1", "10 people", "1.5", "ten", "1e3", "1234567"])(
    "reads a limit of %o as zero",
    (value) => {
      expect(readPublicBetaSignup({ PUBLIC_BETA_SIGNUP_LIMIT: value }).limit).toBe(0);
    },
  );
});

describe("deciding a sign-in", () => {
  const CLOSED_BETA = { mode: "closed-beta" as const };
  const SIGNUP_OFF = { signup: { enabled: false, limit: 10 } };

  it("refuses an unverified address, even one already known, as every sign-in always has", async () => {
    const d = deps({ known: true });

    expect(await decide({ profile: { email: "new@example.com", email_verified: false } }, d)).toBe(false);
    expect(await decide({ profile: undefined }, d)).toBe(false);
    expect(await decide({ ...CLOSED_BETA, profile: { email: "new@example.com", email_verified: false } }, d)).toBe(false);
    expect(d.admit).not.toHaveBeenCalled();
  });

  it("refuses a sign-in that carries no subject", async () => {
    const d = deps();

    expect(await decide({ userId: undefined }, d)).toBe(false);
    expect(d.admit).not.toHaveBeenCalled();
  });

  describe("in Closed Beta", () => {
    it("1: lets an existing user in", async () => {
      const d = deps({ known: true });

      expect(await decide({ ...CLOSED_BETA }, d)).toBe(true);
      expect(d.isKnown).toHaveBeenCalledWith("google-sub-new");
      expect(d.admit).not.toHaveBeenCalled();
    });

    it("2: lets an admitted participant in", async () => {
      // `isKnown` answers yes for an account or a place already taken.
      const d = deps({ known: true });

      expect(await decide({ ...CLOSED_BETA, signup: { enabled: false, limit: 0 } }, d)).toBe(true);
      expect(d.admit).not.toHaveBeenCalled();
    });

    it("3: refuses a new address that is not on the allowlist, taking no place", async () => {
      const d = deps({ known: false });

      expect(await decide({ ...CLOSED_BETA }, d)).toBe(false);
      expect(d.admit).not.toHaveBeenCalled();
    });

    it("4: lets an allowlisted address in without taking a place", async () => {
      const d = deps({ known: false });

      expect(
        await decide({ ...CLOSED_BETA, profile: { email: "QA@Example.com ", email_verified: true }, allowlist: new Set(["qa@example.com"]) }, d),
      ).toBe(true);
      expect(d.admit).not.toHaveBeenCalled();
    });
  });

  describe("in Public Beta", () => {
    it("5: lets an existing user in while signup is disabled", async () => {
      const d = deps({ known: true });

      expect(await decide({ ...SIGNUP_OFF }, d)).toBe(true);
      expect(d.admit).not.toHaveBeenCalled();
    });

    it("6: lets an admitted participant in while signup is disabled", async () => {
      const d = deps({ known: true });

      expect(await decide({ signup: { enabled: false, limit: 0 } }, d)).toBe(true);
      expect(d.admit).not.toHaveBeenCalled();
    });

    it("7: refuses a new user at the cap, and still lets known users in", async () => {
      expect(await decide({}, deps({ known: false, admit: "full" }))).toBe(SIGNUP_FULL_PATH);
      expect(await decide({}, deps({ known: true, admit: "full" }))).toBe(true);
      expect(
        await decide({ allowlist: new Set(["new@example.com"]) }, deps({ known: false, admit: "full" })),
      ).toBe(true);
    });

    it.each([
      ["a missing switch", {}],
      ["a misspelt switch", { PUBLIC_BETA_SIGNUP_ENABLED: "yes", PUBLIC_BETA_SIGNUP_LIMIT: "10" }],
      ["a malformed limit", { PUBLIC_BETA_SIGNUP_ENABLED: "true", PUBLIC_BETA_SIGNUP_LIMIT: "ten" }],
      ["a zero limit", { PUBLIC_BETA_SIGNUP_ENABLED: "true", PUBLIC_BETA_SIGNUP_LIMIT: "0" }],
      ["a negative limit", { PUBLIC_BETA_SIGNUP_ENABLED: "true", PUBLIC_BETA_SIGNUP_LIMIT: "-5" }],
    ])("8: refuses a new user with %s, taking nothing", async (_label, env) => {
      const d = deps({ known: false });

      expect(await decide({ signup: readPublicBetaSignup(env) }, d)).toBe(SIGNUP_CLOSED_PATH);
      expect(d.admit).not.toHaveBeenCalled();
    });

    it("8: refuses a new user when the mode itself is unreadable", async () => {
      const d = deps({ known: false });

      expect(await decide({ mode: readAccessMode("public_beta") }, d)).toBe(false);
      expect(d.admit).not.toHaveBeenCalled();
    });

    it("8: still lets known users in whatever the settings say", async () => {
      const d = deps({ known: true });

      expect(await decide({ signup: readPublicBetaSignup({ PUBLIC_BETA_SIGNUP_LIMIT: "ten" }) }, d)).toBe(true);
      expect(await decide({ mode: readAccessMode("garbage") }, d)).toBe(true);
    });

    it("admits a new verified user while a place is left", async () => {
      const d = deps({ admit: "admitted" });

      expect(await decide({}, d)).toBe(true);
      expect(d.admit).toHaveBeenCalledWith("google-sub-new", 10);
    });
  });

  it("says only full or closed, nothing about the account", () => {
    expect(SIGNUP_FULL_PATH).toBe("/?signup=full");
    expect(SIGNUP_CLOSED_PATH).toBe("/?signup=closed");
  });
});
