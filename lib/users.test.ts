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

  /**
   * Two first writes arriving together, for the same account.
   *
   * **The row is created at the provisioning boundary rather than at sign-in**,
   * so the first thing somebody does after signing in is what creates it — and
   * two tabs, or a form submitted twice, can reach that boundary at once. What
   * makes that survivable is that the write is an upsert addressed by the
   * primary key: both calls name the same row, so the second finds what the
   * first made instead of trying to make a second one.
   *
   * **What this fixes is the shape of the request, not PostgreSQL's answer to
   * it.** The database is replaced here, so nothing below observes a real
   * conflict being resolved; it would still pass against an engine that had no
   * upsert at all. What it catches is the regression that would make the
   * engine's behaviour matter — a `create` where an upsert used to be, or a
   * read-then-write pair with a gap between them for the other call to land
   * in.
   */
  it("addresses one row by id however many first writes arrive at once", async () => {
    const person = { id: USER, email: "someone@example.com" };

    await Promise.all([
      ensureUser(person),
      ensureUser(person),
      ensureUser(person),
    ]);

    expect(upsert).toHaveBeenCalledTimes(3);
    // Nothing looked the row up first: a read outside the write is the gap.
    expect(findUnique).not.toHaveBeenCalled();

    for (const [args] of upsert.mock.calls as [
      { where: { id: string }; create: { id: string } },
    ][]) {
      expect(args.where).toEqual({ id: USER });
      expect(args.create.id).toBe(USER);
    }
  });

  /**
   * Five different people signing in for the first time at once.
   *
   * **Each names its own row and nothing else.** The id is the Google account
   * id, which is also the key every owned row is scoped by — so a provisioning
   * write that reached across accounts would not be a duplicate row, it would
   * be one person's settings landing on another's account.
   */
  it("keeps five accounts' first writes apart", async () => {
    const people = [1, 2, 3, 4, 5].map((n) => ({
      id: `google-sub-${n}`,
      email: `someone-${n}@example.com`,
    }));

    await Promise.all(people.map((person) => ensureUser(person)));

    expect(upsert).toHaveBeenCalledTimes(5);

    const addressed = (upsert.mock.calls as [{ where: { id: string } }][]).map(
      ([args]) => args.where.id,
    );

    expect(new Set(addressed).size).toBe(5);
    expect([...addressed].sort()).toEqual(people.map((person) => person.id));

    // The email written is the one that arrived with that id, not whichever
    // call happened to finish last.
    for (const [args] of upsert.mock.calls as [
      { where: { id: string }; create: { email: string } },
    ][]) {
      const person = people.find((candidate) => candidate.id === args.where.id);

      expect(args.create.email).toBe(person?.email);
    }
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
