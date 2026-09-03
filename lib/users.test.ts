import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What reading a zone answers, and what provisioning refuses to write.
 *
 * These reach the module with the database replaced, so what they fix is the
 * shape of the queries rather than PostgreSQL's behaviour. That is the right
 * boundary for the two properties this checkpoint turns on: which value a read
 * falls back to when the row is not there yet, and that the upsert which
 * creates the row names no zone at all — leaving the column default, and only
 * the column default, to decide.
 */

const { findUnique, update, upsert } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique, update, upsert } },
}));

const { getUserTimezone, ensureUser, setUserTimezone } = await import(
  "@/lib/users"
);
const { NEW_ACCOUNT_TIMEZONE } = await import("@/lib/timezones");

const USER = "google-sub-1";

beforeEach(() => {
  findUnique.mockReset();
  update.mockReset().mockResolvedValue(undefined);
  upsert.mockReset().mockResolvedValue(undefined);
});

describe("getUserTimezone", () => {
  /**
   * **Every existing account keeps the value it has.** The read returns the
   * column, unexamined — including `UTC`, which is the case the default change
   * must not disturb: a row on UTC may have chosen it, and this is where that
   * choice is honoured rather than second-guessed.
   */
  it.each(["UTC", "Asia/Tokyo", "America/New_York", "Europe/London"])(
    "returns the stored zone %o unchanged",
    async (timezone) => {
      findUnique.mockResolvedValue({ timezone });

      await expect(getUserTimezone(USER)).resolves.toBe(timezone);
    },
  );

  /**
   * The account exists in the session but not yet in the database — true of
   * every account until its first write. The answer has to be the zone the row
   * is about to be created with, or the hire form quotes a zone the action
   * that follows it will not use.
   */
  it("falls back to the new-account zone when the row is not there yet", async () => {
    findUnique.mockResolvedValue(null);

    await expect(getUserTimezone(USER)).resolves.toBe(NEW_ACCOUNT_TIMEZONE);
    await expect(getUserTimezone(USER)).resolves.not.toBe("UTC");
  });

  it("reads rather than writes, so a page view creates nothing", async () => {
    findUnique.mockResolvedValue(null);

    await getUserTimezone(USER);

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: USER },
      select: { timezone: true },
    });
    expect(upsert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe("ensureUser", () => {
  /**
   * **The whole of how a new account gets its zone.** Naming `timezone` in
   * `create` would move the decision out of the column and into application
   * code that the migration cannot reach; naming it in `update` would undo a
   * choice every time a profile is refreshed. Neither may appear.
   */
  it("names no timezone when creating or refreshing the row", async () => {
    await ensureUser({
      id: USER,
      email: "someone@example.com",
      name: "Someone",
      image: "https://example.com/a.png",
    });

    expect(upsert).toHaveBeenCalledTimes(1);
    const [{ create, update: refreshed }] = upsert.mock.calls[0] as [
      { create: Record<string, unknown>; update: Record<string, unknown> },
    ];

    expect(create).not.toHaveProperty("timezone");
    expect(refreshed).not.toHaveProperty("timezone");
    expect(JSON.stringify(upsert.mock.calls[0])).not.toContain("timezone");
  });

  it("does not name a language either, for the same reason", async () => {
    await ensureUser({ id: USER, email: "someone@example.com" });

    const [{ create, update: refreshed }] = upsert.mock.calls[0] as [
      { create: Record<string, unknown>; update: Record<string, unknown> },
    ];

    expect(create).not.toHaveProperty("language");
    expect(refreshed).not.toHaveProperty("language");
  });
});

describe("setUserTimezone", () => {
  /** The only path that writes the column, and it writes nothing else. */
  it("updates that one column for that one account", async () => {
    await setUserTimezone(USER, "Asia/Tokyo");

    expect(update).toHaveBeenCalledWith({
      where: { id: USER },
      data: { timezone: "Asia/Tokyo" },
    });
  });

  /**
   * **UTC is still a destination.** Changing the initial value must not turn
   * into removing a choice: an account that asks for UTC gets UTC written.
   */
  it("still writes UTC when that is what was chosen", async () => {
    await setUserTimezone(USER, "UTC");

    expect(update).toHaveBeenCalledWith({
      where: { id: USER },
      data: { timezone: "UTC" },
    });
  });
});
