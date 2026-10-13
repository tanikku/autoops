import { describe, expect, it, vi } from "vitest";
import {
  readAccessMode,
  readPublicBetaSignup,
  SIGNUP_CLOSED_PATH,
  SIGNUP_FULL_PATH,
} from "@/lib/beta-access";
import {
  admitToPublicBeta,
  decideSignIn,
  PUBLIC_BETA_ADMISSION_LOCK,
} from "@/lib/public-beta-admission";

/**
 * Who may sign in, decided in a fixed order in either mode.
 *
 * The database is behind two functions here — whether a subject is already
 * known, and the locked admission — so the order can be fixed exactly. That the
 * admission itself is race-safe is the integration suite's job.
 */

const VERIFIED = { email: "new@example.com", email_verified: true };
const OPEN = { enabled: true, limit: 10 };

const JOINED_AT = new Date("2026-10-14T03:04:05Z");
const OUTCOMES = {
  joined: { status: "joined", participants: 1, admittedAt: JOINED_AT },
  admitted: { status: "admitted" },
  full: { status: "full" },
} as const;

function deps(
  overrides: { known?: boolean; admit?: keyof typeof OUTCOMES; notify?: () => Promise<void> } = {},
) {
  return {
    isKnown: vi.fn(async () => overrides.known ?? false),
    admit: vi.fn(async () => OUTCOMES[overrides.admit ?? "joined"]),
    notifyJoined: vi.fn(overrides.notify ?? (async () => {})),
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

/**
 * The admission's own steps, against a stand-in transaction that records them.
 * Whether the lock really serialises arrivals is the integration suite's job;
 * this fixes that the count reported for a new place is read inside it.
 */
describe("admitting within the lock", () => {
  function fakeClient(state: { existing?: boolean; count: number }) {
    const steps: string[] = [];
    const tx = {
      $executeRaw: vi.fn(async () => {
        steps.push("lock");
        return 0;
      }),
      publicBetaAdmission: {
        findUnique: vi.fn(async () => {
          steps.push("find");
          return state.existing ? { userId: "google-sub-new" } : null;
        }),
        count: vi.fn(async () => {
          steps.push("count");
          return state.count;
        }),
        create: vi.fn(async () => {
          steps.push("create");
          state.count += 1;
          return { admittedAt: JOINED_AT };
        }),
      },
    };
    const client = {
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
        steps.push("begin");
        const result = await fn(tx);
        steps.push("commit");
        return result;
      }),
    };
    return { client: client as unknown as Parameters<typeof admitToPublicBeta>[0], tx, steps };
  }

  it("reports the first place of ten as participant 1, counted after the insert inside the lock", async () => {
    const { client, tx, steps } = fakeClient({ count: 0 });

    expect(await admitToPublicBeta(client, "google-sub-new", 10)).toEqual({
      status: "joined",
      participants: 1,
      admittedAt: JOINED_AT,
    });
    expect(steps).toEqual(["begin", "lock", "find", "count", "create", "count", "commit"]);
    expect(tx.$executeRaw.mock.calls[0].slice(1)).toEqual([PUBLIC_BETA_ADMISSION_LOCK]);
  });

  it("does not call an existing place new, and creates nothing", async () => {
    const { client, tx } = fakeClient({ existing: true, count: 3 });

    expect(await admitToPublicBeta(client, "google-sub-new", 10)).toEqual({ status: "admitted" });
    expect(tx.publicBetaAdmission.create).not.toHaveBeenCalled();
  });

  it("refuses at the cap as before, creating nothing", async () => {
    const { client, tx } = fakeClient({ count: 10 });

    expect(await admitToPublicBeta(client, "google-sub-new", 10)).toEqual({ status: "full" });
    expect(tx.publicBetaAdmission.create).not.toHaveBeenCalled();
  });
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
      const d = deps({ admit: "joined" });

      expect(await decide({}, d)).toBe(true);
      expect(d.admit).toHaveBeenCalledWith("google-sub-new", 10);
    });
  });

  describe("reporting a new place", () => {
    it("reports a place this sign-in created, once, after the admission returned", async () => {
      const d = deps({ admit: "joined" });

      expect(await decide({}, d)).toBe(true);
      expect(d.notifyJoined).toHaveBeenCalledTimes(1);
      expect(d.notifyJoined).toHaveBeenCalledWith({ participants: 1, limit: 10, admittedAt: JOINED_AT });
      expect(d.admit.mock.invocationCallOrder[0]).toBeLessThan(d.notifyJoined.mock.invocationCallOrder[0]);
    });

    it("does not report a place that already existed, as when the same subject raced itself", async () => {
      const d = deps({ admit: "admitted" });

      expect(await decide({}, d)).toBe(true);
      expect(d.notifyJoined).not.toHaveBeenCalled();
    });

    it.each<[string, Partial<Parameters<typeof decideSignIn>[0]>, Parameters<typeof deps>[0]]>([
      ["a full beta", {}, { admit: "full" }],
      ["an allowlisted address", { allowlist: new Set(["new@example.com"]) }, {}],
      ["an existing user or participant", {}, { known: true }],
      ["closed signup", { signup: { enabled: false, limit: 10 } }, {}],
      ["Closed Beta", { mode: "closed-beta" }, {}],
    ])("reports nothing for %s", async (_label, input, overrides) => {
      const d = deps(overrides);

      await decide(input, d);
      expect(d.notifyJoined).not.toHaveBeenCalled();
    });

    it.each([
      ["rejects", async () => Promise.reject(new Error("boom"))],
      ["throws", () => {
        throw new Error("boom");
      }],
    ])("still lets the participant in when the report %s", async (_label, notify) => {
      const d = deps({ admit: "joined", notify: notify as () => Promise<void> });

      expect(await decide({}, d)).toBe(true);
      expect(d.notifyJoined).toHaveBeenCalledTimes(1);
    });
  });

  it("says only full or closed, nothing about the account", () => {
    expect(SIGNUP_FULL_PATH).toBe("/?signup=full");
    expect(SIGNUP_CLOSED_PATH).toBe("/?signup=closed");
  });
});
