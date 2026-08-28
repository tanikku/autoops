import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What spacing out one host's fetches promises, and what it does not.
 *
 * These reach the primitive with the database replaced, so what they fix is the
 * shape of the write — which row is matched, under what condition, and what
 * each answer means. **That two callers cannot both take the same turn is not
 * something a mock can show**: a conditional `UPDATE` racing another is a
 * property of PostgreSQL, and it is verified the way `claimRoutineSlot`'s
 * exclusivity is, against a real database.
 *
 * What is worth fixing here is everything that would quietly disable it: that
 * the due time is a condition inside the write rather than a value read back
 * and compared, that a refusal says how long to wait, and that the retry after
 * a lost create happens exactly once.
 */

const { updateMany, findUnique, create } = vi.hoisted(() => ({
  updateMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { domainThrottle: { updateMany, findUnique, create } },
}));

const throttleModule = await import("@/lib/website-throttle");
const { acquireWebsiteDomainThrottle, WEBSITE_DOMAIN_INTERVAL_MS } =
  throttleModule;

const NOW = new Date("2026-08-28T12:00:00.000Z");
const HOST = "example.com";

/** The argument of the nth `updateMany`, counting from one. */
function updateCall(n: number) {
  return updateMany.mock.calls[n - 1][0];
}

function uniqueViolation() {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
  });
}

/**
 * Whether a row due at `nextAllowedAt` is matched by the `where` the module
 * built. **The boundary is the thing under test**, so it is evaluated rather
 * than asserted on as a date.
 */
function matchesDue(
  where: { nextAllowedAt: { lte: Date } },
  nextAllowedAt: Date,
) {
  return nextAllowedAt.getTime() <= where.nextAllowedAt.lte.getTime();
}

beforeEach(() => {
  updateMany.mockReset();
  findUnique.mockReset();
  create.mockReset();
});

describe("the interval itself", () => {
  it("is ten seconds", () => {
    expect(WEBSITE_DOMAIN_INTERVAL_MS).toBe(10_000);
  });

  /**
   * **Nothing is held, so nothing is given back.** A turn is a time moving
   * forward; there is no token to release and no expiry to sweep, which is what
   * makes a process that dies mid-fetch leave nothing behind.
   */
  it("offers no way to release a turn", () => {
    expect(Object.keys(throttleModule).sort()).toEqual([
      "WEBSITE_DOMAIN_INTERVAL_MS",
      "acquireWebsiteDomainThrottle",
    ]);
  });
});

describe("acquireWebsiteDomainThrottle", () => {
  it("takes the turn when the host is due", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    expect(await acquireWebsiteDomainThrottle(HOST, NOW)).toEqual({
      allowed: true,
    });
  });

  it("pushes the next turn one interval out", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await acquireWebsiteDomainThrottle(HOST, NOW);

    expect(updateCall(1)).toEqual({
      where: { host: HOST, nextAllowedAt: { lte: NOW } },
      data: {
        nextAllowedAt: new Date(NOW.getTime() + WEBSITE_DOMAIN_INTERVAL_MS),
      },
    });
  });

  it("counts the instant a turn comes due as due", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await acquireWebsiteDomainThrottle(HOST, NOW);

    expect(matchesDue(updateCall(1).where, NOW)).toBe(true);
    expect(matchesDue(updateCall(1).where, new Date(NOW.getTime() + 1))).toBe(
      false,
    );
  });

  it("refuses a host whose turn has not come, and says how long", async () => {
    const nextAllowedAt = new Date(NOW.getTime() + 4_000);
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({ host: HOST, nextAllowedAt });

    expect(await acquireWebsiteDomainThrottle(HOST, NOW)).toEqual({
      allowed: false,
      retryAfterMs: 4_000,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("never reports a negative wait", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({
      host: HOST,
      nextAllowedAt: new Date(NOW.getTime() - 5_000),
    });

    expect(await acquireWebsiteDomainThrottle(HOST, NOW)).toEqual({
      allowed: false,
      retryAfterMs: 0,
    });
  });

  it("keeps hosts apart", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await acquireWebsiteDomainThrottle("news.example.com", NOW);

    expect(updateCall(1).where.host).toBe("news.example.com");
    // No owner, no account: two people watching the same page share this row.
    expect(Object.keys(updateCall(1).where).sort()).toEqual([
      "host",
      "nextAllowedAt",
    ]);
  });
});

describe("acquireWebsiteDomainThrottle — a host nobody has fetched", () => {
  it("creates the row already holding this turn", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue({ host: HOST });

    expect(await acquireWebsiteDomainThrottle(HOST, NOW)).toEqual({
      allowed: true,
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        host: HOST,
        nextAllowedAt: new Date(NOW.getTime() + WEBSITE_DOMAIN_INTERVAL_MS),
      },
    });
  });

  it("takes the turn somebody else created, when theirs has elapsed", async () => {
    updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    findUnique.mockResolvedValue(null);
    create.mockRejectedValue(uniqueViolation());

    expect(await acquireWebsiteDomainThrottle(HOST, NOW)).toEqual({
      allowed: true,
    });
    // Once more, and only once: the row exists now, and asking again would
    // spin against a clock that has not moved.
    expect(updateMany).toHaveBeenCalledTimes(2);
  });

  it("waits for the request that beat it to the create", async () => {
    const nextAllowedAt = new Date(NOW.getTime() + WEBSITE_DOMAIN_INTERVAL_MS);
    updateMany.mockResolvedValue({ count: 0 });
    findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ host: HOST, nextAllowedAt });
    create.mockRejectedValue(uniqueViolation());

    expect(await acquireWebsiteDomainThrottle(HOST, NOW)).toEqual({
      allowed: false,
      retryAfterMs: WEBSITE_DOMAIN_INTERVAL_MS,
    });
    expect(updateMany).toHaveBeenCalledTimes(2);
  });
});

describe("acquireWebsiteDomainThrottle — a database that will not answer", () => {
  it("throws rather than allowing when the write fails", async () => {
    updateMany.mockRejectedValue(new Error("connection terminated"));

    await expect(acquireWebsiteDomainThrottle(HOST, NOW)).rejects.toThrow(
      "connection terminated",
    );
  });

  it("throws a create failure that is not the unique constraint", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue(null);
    create.mockRejectedValue(
      Object.assign(new Error("disk full"), { code: "P2010" }),
    );

    await expect(acquireWebsiteDomainThrottle(HOST, NOW)).rejects.toThrow(
      "disk full",
    );
  });
});
