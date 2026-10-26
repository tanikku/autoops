import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Whether a page should ask the owner to choose which worker emails them.
 *
 * Only on a one-worker plan, with nobody chosen, and with two or more workers
 * switched on — the one state the billing run will not resolve by itself.
 */

const routineCount = vi.fn();
const getEffectiveEntitlement = vi.fn();

vi.mock("@/lib/prisma", () => ({ prisma: { routine: { count: routineCount } } }));
vi.mock("@/lib/entitlements/index", () => ({
  computeEntitlement: vi.fn(),
  getEffectiveEntitlement,
}));

const { readEmailSelection, readEmailSelectionNeeded } = await import(
  "@/lib/notification-worker"
);

const USER = "user-1";

function entitlement(email: "none" | "one-worker" | "all-workers", chosen: string | null) {
  return {
    entitled: email !== "none",
    limits: email === "none" ? null : { email },
    notificationWorkerId: chosen,
  };
}

beforeEach(() => {
  routineCount.mockReset().mockResolvedValue(0);
  getEffectiveEntitlement.mockReset().mockResolvedValue(entitlement("one-worker", null));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("asking the owner to choose", () => {
  it.each([
    [2, true],
    [3, true],
    [1, false],
    [0, false],
  ])("on Lite with nobody chosen and %i switched on: %s", async (enabled, needed) => {
    routineCount.mockResolvedValue(enabled);

    expect(await readEmailSelectionNeeded(USER)).toBe(needed);
  });

  it("counts this account's switched-on workers", async () => {
    await readEmailSelectionNeeded(USER);

    expect(routineCount).toHaveBeenCalledWith({
      where: { userId: USER, emailNotificationsEnabled: true },
    });
  });

  it("does not ask once somebody is chosen", async () => {
    getEffectiveEntitlement.mockResolvedValue(entitlement("one-worker", "w1"));
    routineCount.mockResolvedValue(5);

    expect(await readEmailSelectionNeeded(USER)).toBe(false);
    expect(routineCount).not.toHaveBeenCalled();
  });

  it.each(["all-workers", "none"] as const)("does not ask on a plan where email is %s", async (email) => {
    getEffectiveEntitlement.mockResolvedValue(entitlement(email, null));
    routineCount.mockResolvedValue(5);

    expect(await readEmailSelectionNeeded(USER)).toBe(false);
  });

  /** A page says nothing rather than the wrong thing. */
  it.each([
    ["the entitlement", () => getEffectiveEntitlement.mockRejectedValue(new Error("db"))],
    ["the count", () => routineCount.mockRejectedValue(new Error("db"))],
  ])("does not ask when %s cannot be read", async (_label, fail) => {
    routineCount.mockResolvedValue(2);
    fail();

    expect(await readEmailSelectionNeeded(USER)).toBe(false);
  });
});

describe("reading the selection for a page", () => {
  it("gives the plan's email entitlement and the chosen worker", async () => {
    getEffectiveEntitlement.mockResolvedValue(entitlement("one-worker", "w1"));

    expect(await readEmailSelection(USER)).toEqual({
      entitlement: "one-worker",
      notificationWorkerId: "w1",
    });
  });

  it("is undefined when it cannot be read", async () => {
    getEffectiveEntitlement.mockRejectedValue(new Error("db"));

    expect(await readEmailSelection(USER)).toBeUndefined();
  });
});

/** N2P-F4: a failed read is logged as a category, never as the error. */
describe("logging a failed read", () => {
  it("writes the category and not what the error said", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    getEffectiveEntitlement.mockRejectedValue(
      Object.assign(new Error("timeout for user-secret alice@example.com"), {
        name: "PrismaClientKnownRequestError",
        code: "P2024",
      }),
    );

    await readEmailSelection(USER);
    const written = logged.mock.calls.flat().map(String).join(" ");

    expect(written).toContain(
      "[worker] email selection could not be read for the page — category=timeout code=P2024",
    );
    expect(written).not.toContain("user-secret");
    expect(written).not.toContain("alice@example.com");
    expect(logged.mock.calls.flat().every((arg) => typeof arg === "string")).toBe(true);
  });
});
