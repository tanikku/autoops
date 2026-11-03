import { beforeEach, describe, expect, it, vi } from "vitest";
import { Console } from "node:console";
import { Writable } from "node:stream";

/**
 * Where the account row is created, and where it deliberately is not.
 *
 * Two functions sit here and the difference between them is the whole point:
 * one establishes who is asking, the other also guarantees AutoOps has a row
 * to keep their settings in. Reads use the first, and a read that quietly
 * became a write would put an upsert behind every page view — so "never
 * provisions" is a contract, not an implementation detail.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  ensureUser: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/users", () => ({ ensureUser: mocks.ensureUser }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

const {
  isDeletedAccountError,
  isUserProvisioningError,
  ProvisioningUnverifiableError,
  requireProvisionedUserId,
  requireUserId,
} = await import("@/lib/session");
const { AccountDeletedError, TombstoneUnverifiableError } = await import(
  "@/lib/account-tombstone"
);

/**
 * `redirect` leaves by throwing, and the code under test relies on that: the
 * lines after it never run. A mock that returned would let execution carry on
 * with no id, which is not what production does.
 */
class RedirectSignal extends Error {}

const signedIn = {
  user: {
    id: "google-sub-1",
    email: "someone@example.com",
    name: "Someone",
    image: "https://example.com/avatar.png",
  },
};

beforeEach(() => {
  mocks.auth.mockReset().mockResolvedValue(signedIn);
  mocks.ensureUser.mockReset().mockResolvedValue(undefined);
  mocks.redirect.mockReset().mockImplementation((to: string) => {
    throw new RedirectSignal(to);
  });
});

describe("requireUserId", () => {
  it("returns the tenant key from the session", async () => {
    expect(await requireUserId()).toBe("google-sub-1");
  });

  /**
   * The one that matters for every page on the dashboard. Provisioning here
   * would turn each render into a write, which is exactly what the split
   * between these two functions exists to prevent.
   */
  it("never provisions the account row", async () => {
    await requireUserId();

    expect(mocks.ensureUser).not.toHaveBeenCalled();
  });

  it("sends a visitor with no session back to sign in", async () => {
    mocks.auth.mockResolvedValue(null);

    await expect(requireUserId()).rejects.toBeInstanceOf(RedirectSignal);
    expect(mocks.ensureUser).not.toHaveBeenCalled();
  });
});

describe("requireProvisionedUserId", () => {
  it("provisions the account row and returns the tenant key", async () => {
    expect(await requireProvisionedUserId()).toBe("google-sub-1");
    expect(mocks.ensureUser).toHaveBeenCalledTimes(1);
  });

  it("passes the provider profile through", async () => {
    await requireProvisionedUserId();

    expect(mocks.ensureUser).toHaveBeenCalledWith({
      id: "google-sub-1",
      email: "someone@example.com",
      name: "Someone",
      image: "https://example.com/avatar.png",
    });
  });

  /**
   * The timezone is AutoOps' own, not the provider's. Sending one here would
   * let a sign-in reset a setting the account chose.
   */
  it("does not send a timezone, so refreshing the profile cannot reset one", async () => {
    await requireProvisionedUserId();

    expect(mocks.ensureUser.mock.calls[0][0]).not.toHaveProperty("timezone");
  });

  it("can be asked more than once", async () => {
    expect(await requireProvisionedUserId()).toBe("google-sub-1");
    expect(await requireProvisionedUserId()).toBe("google-sub-1");
    expect(mocks.ensureUser).toHaveBeenCalledTimes(2);
  });

  /**
   * `User.email` is `NOT NULL` and unique. A placeholder would satisfy the
   * column and invent an identity the constraint then treats as real, so a
   * session without one is stopped exactly like a session without an id.
   */
  it("refuses to invent an account when the session carries no email", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "google-sub-1" } });

    await expect(requireProvisionedUserId()).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(mocks.ensureUser).not.toHaveBeenCalled();
  });

  it("sends a visitor with no session back to sign in", async () => {
    mocks.auth.mockResolvedValue(null);

    await expect(requireProvisionedUserId()).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(mocks.ensureUser).not.toHaveBeenCalled();
  });

  it("names a failure to write the row, keeping the original as its cause", async () => {
    const cause = new Error("connection terminated");
    mocks.ensureUser.mockRejectedValue(cause);

    const error = await requireProvisionedUserId().catch((thrown) => thrown);

    expect(isUserProvisioningError(error)).toBe(true);
    expect((error as Error).cause).toBe(cause);
  });

  /**
   * A redirect travels as a thrown error too. Callers tell the two apart to
   * decide what to swallow, so this one must not answer to the predicate.
   */
  it("does not disguise a redirect as a provisioning failure", async () => {
    mocks.auth.mockResolvedValue(null);

    const error = await requireProvisionedUserId().catch((thrown) => thrown);

    expect(isUserProvisioningError(error)).toBe(false);
  });

  /**
   * **A deleted account is refused as a provisioning failure**, so every
   * existing caller already stops before its write — and is told apart from a
   * database that did not answer by its own predicate.
   */
  it("refuses a deleted account as its own kind of provisioning failure", async () => {
    mocks.ensureUser.mockRejectedValue(new AccountDeletedError());

    const error = await requireProvisionedUserId().catch((thrown) => thrown);

    expect(isUserProvisioningError(error)).toBe(true);
    expect(isDeletedAccountError(error)).toBe(true);
    expect((error as Error).message).not.toContain("google-sub");
  });

  it.each([
    ["a database failure", new Error("connection terminated")],
    ["a check that could not be completed", new TombstoneUnverifiableError()],
  ])("does not call %s a deleted account", async (_label, cause) => {
    mocks.ensureUser.mockRejectedValue(cause);

    const error = await requireProvisionedUserId().catch((thrown) => thrown);

    expect(isUserProvisioningError(error)).toBe(true);
    expect(isDeletedAccountError(error)).toBe(false);
  });
});

/**
 * What a refused provisioning reveals when it is logged whole.
 *
 * **Through Node's own console, not a stand-in.** A `Console` writing into a
 * string is the same formatter `console.error` uses — message, stack and the
 * `[cause]` chain — so what it prints is what a server log would hold.
 */
describe("what a refused provisioning reveals", () => {
  const SUBJECT = "google-sub-1";

  function printed(error: unknown): string {
    let out = "";
    const sink = new Writable({
      write(chunk, _encoding, done) {
        out += String(chunk);
        done();
      },
    });
    new Console({ stdout: sink, stderr: sink }).error("[settings] could not provision the account row", error);
    return out;
  }

  async function refusal(cause: unknown) {
    mocks.ensureUser.mockRejectedValue(cause);
    return (await requireProvisionedUserId().catch((thrown) => thrown)) as Error;
  }

  describe("when whether the account was deleted cannot be checked", () => {
    it("is its own provisioning failure, and not a deleted account", async () => {
      const error = await refusal(new TombstoneUnverifiableError());

      expect(error).toBeInstanceOf(ProvisioningUnverifiableError);
      expect(isUserProvisioningError(error)).toBe(true);
      expect(isDeletedAccountError(error)).toBe(false);
      // Classified by name in the billing log, as every provisioning failure is.
      expect(error.name).toBe("UserProvisioningError");
    });

    it("keeps the subject out of its message, stack and cause", async () => {
      const error = await refusal(new TombstoneUnverifiableError());
      const cause = error.cause as Error;

      expect(error.message).not.toContain(SUBJECT);
      expect(error.stack).not.toContain(SUBJECT);
      expect(cause).toBeInstanceOf(TombstoneUnverifiableError);
      expect(cause.message).not.toContain(SUBJECT);
      expect(cause.stack).not.toContain(SUBJECT);
    });

    it("keeps the subject out of everything console.error prints", async () => {
      const out = printed(await refusal(new TombstoneUnverifiableError()));

      expect(out).toContain("could not be checked");
      expect(out).not.toContain(SUBJECT);
    });
  });

  describe("when the account was deleted", () => {
    it("keeps the subject out of everything console.error prints", async () => {
      const error = await refusal(new AccountDeletedError());
      const out = printed(error);

      expect(error.stack).not.toContain(SUBJECT);
      expect(out).toContain("has been deleted");
      expect(out).not.toContain(SUBJECT);
    });
  });

  /** The three are told apart: a database failure is neither of the others. */
  it("keeps a database failure what it always was", async () => {
    const cause = new Error("connection terminated");
    const error = await refusal(cause);

    expect(isUserProvisioningError(error)).toBe(true);
    expect(isDeletedAccountError(error)).toBe(false);
    expect(error).not.toBeInstanceOf(ProvisioningUnverifiableError);
    expect(error.cause).toBe(cause);
    // Unchanged on purpose: this message has always named the account. That it
    // shows up here is also what proves the capture above would catch a leak.
    expect(printed(error)).toContain(SUBJECT);
  });

  it("leaves an ordinary provisioning as it was", async () => {
    mocks.ensureUser.mockReset().mockResolvedValue(undefined);

    expect(await requireProvisionedUserId()).toBe(SUBJECT);
    expect(mocks.ensureUser).toHaveBeenCalledTimes(1);
  });
});
