import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Which sign-in rule `auth.ts` runs, chosen by the mode it was started in.
 *
 * `next-auth` is replaced to capture the configuration, and the decision is
 * replaced to see what it is handed. The decision itself is `lib/public-beta-admission.test.ts`'s; this
 * fixes what it is given. The environment is read when the module loads, so
 * each case loads it fresh.
 */

const mocks = vi.hoisted(() => ({
  config: null as null | { callbacks: { signIn: (args: unknown) => Promise<unknown> | unknown } },
  decide: vi.fn(),
  isKnown: vi.fn(),
  admit: vi.fn(),
}));

vi.mock("next-auth", () => ({
  default: (config: typeof mocks.config) => {
    mocks.config = config;
    return { handlers: {}, signIn: vi.fn(), signOut: vi.fn(), auth: vi.fn() };
  },
}));
vi.mock("next-auth/providers/google", () => ({ default: {} }));
vi.mock("@/lib/prisma", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/lib/public-beta-admission", () => ({
  decideSignIn: mocks.decide,
  isKnownSubject: mocks.isKnown,
  admitToPublicBeta: mocks.admit,
}));

const ENV_KEYS = [
  "AUTH_ACCESS_MODE",
  "PUBLIC_BETA_SIGNUP_ENABLED",
  "PUBLIC_BETA_SIGNUP_LIMIT",
  "BETA_ALLOWED_EMAILS",
] as const;
const saved: Record<string, string | undefined> = {};

async function load(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) {
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }
  vi.resetModules();
  await import("@/auth");
  return mocks.config!.callbacks.signIn;
}

const stranger = { profile: { email: "new@example.com", email_verified: true }, account: { providerAccountId: "sub-new" } };

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  mocks.decide.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("the mode the decision is given", () => {
  it.each([
    [undefined, "closed-beta"],
    ["closed-beta", "closed-beta"],
    ["public_beta", "closed-beta"],
    ["public-beta", "public-beta"],
  ])("passes mode %o on as %s", async (mode, expected) => {
    const signIn = await load({ AUTH_ACCESS_MODE: mode, BETA_ALLOWED_EMAILS: "qa@example.com" });

    await signIn(stranger);

    expect(mocks.decide.mock.calls[0][0].mode).toBe(expected);
  });

  it("hands over the subject, the list and the cap", async () => {
    const signIn = await load({
      AUTH_ACCESS_MODE: "public-beta",
      PUBLIC_BETA_SIGNUP_ENABLED: "true",
      PUBLIC_BETA_SIGNUP_LIMIT: "10",
      BETA_ALLOWED_EMAILS: "qa@example.com",
    });

    await signIn(stranger);

    const [input] = mocks.decide.mock.calls[0];
    expect(input).toMatchObject({
      userId: "sub-new",
      signup: { enabled: true, limit: 10 },
      profile: stranger.profile,
    });
    expect([...input.allowlist]).toEqual(["qa@example.com"]);
  });

  it("reads a broken switch and cap as closed", async () => {
    const signIn = await load({
      AUTH_ACCESS_MODE: "public-beta",
      PUBLIC_BETA_SIGNUP_ENABLED: "yes",
      PUBLIC_BETA_SIGNUP_LIMIT: "ten",
    });

    await signIn(stranger);

    expect(mocks.decide.mock.calls[0][0].signup).toEqual({ enabled: false, limit: 0 });
  });

  it("returns the decision's answer as the sign-in's", async () => {
    mocks.decide.mockResolvedValue("/?signup=full");
    const signIn = await load({ AUTH_ACCESS_MODE: "public-beta" });

    expect(await signIn(stranger)).toBe("/?signup=full");
  });
});

/** The middleware must not pull the database into the edge bundle. */
describe("the edge-safe half", () => {
  it("is what the middleware loads, and it imports no database", () => {
    const middleware = readFileSync("middleware.ts", "utf8");
    const config = readFileSync("auth.config.ts", "utf8");

    expect(middleware).toContain('from "@/auth.config"');
    expect(middleware).not.toMatch(/from "@\/auth"/);
    expect(config).not.toMatch(/prisma|public-beta-admission|@\/lib\//);
  });
});
