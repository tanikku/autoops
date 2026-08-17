import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The baseline a watched page is compared against, and what moves it.
 *
 * Two things are fixed here. **Absence means "never read"** — the row does not
 * exist until a page has been fetched successfully once, and that is a
 * different state from a page that served nothing. And **the two writes are
 * different writes**: a page that changed replaces the baseline, a page that
 * did not moves one timestamp and leaves the content alone.
 *
 * **Nothing here decides when to call them.** The rule that a change is only
 * baselined once the work it triggered has succeeded is execution's, and lives
 * where the run does.
 */

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    websiteSnapshot: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
      updateMany: mocks.updateMany,
      create: mocks.create,
    },
  },
}));

const {
  createWebsiteSnapshotBaseline,
  getWebsiteSnapshot,
  isWebsiteStateConflict,
  markWebsiteSnapshotChecked,
  markWebsiteSnapshotCheckedIfCurrent,
  saveWebsiteSnapshot,
} = await import("@/lib/website-snapshots");

const FIRST = new Date("2026-08-13T09:00:00.000Z");
const LATER = new Date("2026-08-14T09:00:00.000Z");

/** A baseline that has been established and has not changed since. */
const SNAPSHOT_ROW = {
  id: "snapshot-1",
  websiteSourceId: "source-1",
  normalizedContent: "the page as text",
  contentHash: "abc123",
  lastCheckedAt: FIRST,
  lastChangedAt: null,
  createdAt: FIRST,
};

beforeEach(() => {
  mocks.findUnique.mockReset().mockResolvedValue(SNAPSHOT_ROW);
  mocks.upsert.mockReset().mockResolvedValue(SNAPSHOT_ROW);
  mocks.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mocks.create.mockReset().mockResolvedValue(SNAPSHOT_ROW);
});

/**
 * Establishing the first baseline, and the race that makes it a create.
 *
 * **Two runs can both find no baseline.** An upsert would let the second write
 * over the first, and the change the first was about to report would be gone
 * with it. A create lets the unique constraint decide, and the loser is told
 * rather than silently promoted to a winner.
 */
describe("creating the first baseline", () => {
  const BASELINE = {
    normalizedContent: "the page as text",
    contentHash: "abc123",
    at: FIRST,
  };

  it("creates, and does not upsert", async () => {
    await createWebsiteSnapshotBaseline("source-1", BASELINE);

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("writes the source, the content, the digest and when it was read", async () => {
    await createWebsiteSnapshotBaseline("source-1", BASELINE);

    expect(mocks.create.mock.calls[0][0].data).toEqual({
      websiteSourceId: "source-1",
      normalizedContent: "the page as text",
      contentHash: "abc123",
      lastCheckedAt: FIRST,
    });
  });

  /** A first read is not a change, so the column that dates one stays unset. */
  it("leaves lastChangedAt out entirely", async () => {
    await createWebsiteSnapshotBaseline("source-1", BASELINE);

    expect(mocks.create.mock.calls[0][0].data).not.toHaveProperty(
      "lastChangedAt",
    );
  });

  /**
   * **The unique constraint is the race protection**, and losing it has to
   * surface. Turning it into "fine, it exists now" would be the upsert again.
   */
  it("reports a unique violation as a conflict", async () => {
    mocks.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );

    await expect(
      createWebsiteSnapshotBaseline("source-1", BASELINE),
    ).rejects.toSatisfy(isWebsiteStateConflict);
  });

  it("says nothing about the content in the conflict", async () => {
    mocks.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );

    await expect(
      createWebsiteSnapshotBaseline("source-1", BASELINE),
    ).rejects.toThrow("Website state changed during execution.");
  });

  it("lets any other database failure through as it is", async () => {
    mocks.create.mockRejectedValue(new Error("connection lost"));

    await expect(
      createWebsiteSnapshotBaseline("source-1", BASELINE),
    ).rejects.toThrow("connection lost");
  });

  it("uses the client it was given", async () => {
    const tx = { websiteSnapshot: { create: vi.fn().mockResolvedValue(SNAPSHOT_ROW) } };

    await createWebsiteSnapshotBaseline(
      "source-1",
      BASELINE,
      tx as unknown as Parameters<typeof createWebsiteSnapshotBaseline>[2],
    );

    expect(tx.websiteSnapshot.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

/**
 * Recording a check, but only while the baseline is the one that was compared
 * against.
 *
 * **The condition is what makes this safe to combine with the run's own
 * write.** Seconds pass between reading a baseline and writing; another run may
 * have advanced it. Matching on what was read means the write lands on the
 * state the decision was about, or not at all.
 */
describe("recording a check against the baseline that was compared", () => {
  const EXPECTED = {
    normalizedContent: "the page as text",
    contentHash: "abc123",
  };

  it("matches on the source, the digest and the content", async () => {
    await markWebsiteSnapshotCheckedIfCurrent("source-1", EXPECTED, LATER);

    expect(mocks.updateMany.mock.calls[0][0].where).toEqual({
      websiteSourceId: "source-1",
      contentHash: "abc123",
      normalizedContent: "the page as text",
    });
  });

  /**
   * **Both, not just the digest.** The comparison that produced this decision
   * insisted on the two agreeing; the condition holds the database to the same
   * standard rather than a weaker one.
   */
  it("does not settle for the digest alone", async () => {
    await markWebsiteSnapshotCheckedIfCurrent("source-1", EXPECTED, LATER);

    expect(mocks.updateMany.mock.calls[0][0].where).toHaveProperty(
      "normalizedContent",
    );
  });

  it("moves when it was last read, and nothing else", async () => {
    await markWebsiteSnapshotCheckedIfCurrent("source-1", EXPECTED, LATER);

    const { data } = mocks.updateMany.mock.calls[0][0];
    expect(data).toEqual({ lastCheckedAt: LATER });
    expect(Object.keys(data)).toEqual(["lastCheckedAt"]);
  });

  it.each(["normalizedContent", "contentHash", "lastChangedAt"])(
    "never writes %s",
    async (field) => {
      await markWebsiteSnapshotCheckedIfCurrent("source-1", EXPECTED, LATER);

      expect(mocks.updateMany.mock.calls[0][0].data).not.toHaveProperty(field);
    },
  );

  it("reports success when exactly one row matched", async () => {
    expect(
      await markWebsiteSnapshotCheckedIfCurrent("source-1", EXPECTED, LATER),
    ).toBe(true);
  });

  it("reports a conflict when nothing matched", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });

    expect(
      await markWebsiteSnapshotCheckedIfCurrent("source-1", EXPECTED, LATER),
    ).toBe(false);
  });

  /**
   * The source is unique, so more than one is impossible — and treating it as
   * fine anyway would mean the number that says "this landed where it was
   * meant to" had stopped being checked.
   */
  it("does not treat any other count as success", async () => {
    mocks.updateMany.mockResolvedValue({ count: 2 });

    expect(
      await markWebsiteSnapshotCheckedIfCurrent("source-1", EXPECTED, LATER),
    ).toBe(false);
  });

  it("uses the client it was given", async () => {
    const tx = {
      websiteSnapshot: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };

    await markWebsiteSnapshotCheckedIfCurrent(
      "source-1",
      EXPECTED,
      LATER,
      tx as unknown as Parameters<typeof markWebsiteSnapshotCheckedIfCurrent>[3],
    );

    expect(tx.websiteSnapshot.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("uses the module's client when given none", async () => {
    await markWebsiteSnapshotCheckedIfCurrent("source-1", EXPECTED, LATER);

    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("having no baseline yet", () => {
  /**
   * **The first-run state, and the only thing that means it.** An empty string
   * would be ambiguous: a page that legitimately serves nothing would be
   * indistinguishable from one nobody has read.
   */
  it("comes back as null rather than as an empty snapshot", async () => {
    mocks.findUnique.mockResolvedValue(null);

    expect(await getWebsiteSnapshot("source-1")).toBeNull();
  });

  it("is read by the source it belongs to", async () => {
    await getWebsiteSnapshot("source-1");

    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { websiteSourceId: "source-1" },
    });
  });

  it("names the fields it hands back rather than spreading the row", async () => {
    mocks.findUnique.mockResolvedValue({
      ...SNAPSHOT_ROW,
      somethingAddedLater: "should not travel",
    });

    expect(await getWebsiteSnapshot("source-1")).toEqual(SNAPSHOT_ROW);
  });
});

describe("establishing the first baseline", () => {
  /**
   * **A first read is not a change.** There was nothing to differ from, so
   * dating a change to the moment watching started would report one to somebody
   * who had not been watching yet. The column is left null, which says
   * "nothing has happened since we started" — a different thing from "something
   * happened right at the start", and a different thing again from a missing
   * value.
   */
  it("records when the page was read and leaves the change unset", async () => {
    await saveWebsiteSnapshot("source-1", {
      normalizedContent: "the page as text",
      contentHash: "abc123",
      at: FIRST,
    });

    const { create } = mocks.upsert.mock.calls[0][0];
    expect(create).toEqual({
      websiteSourceId: "source-1",
      normalizedContent: "the page as text",
      contentHash: "abc123",
      lastCheckedAt: FIRST,
    });
    expect(create).not.toHaveProperty("lastChangedAt");
  });

  it("reads back as a snapshot that has never changed", async () => {
    expect((await getWebsiteSnapshot("source-1"))?.lastChangedAt).toBeNull();
  });

  /**
   * `lastCheckedAt` is not optional the way `lastChangedAt` is: a snapshot
   * exists because a page was read, so there is always a moment to record.
   */
  it("always records when it was read", async () => {
    await saveWebsiteSnapshot("source-1", {
      normalizedContent: "the page as text",
      contentHash: "abc123",
      at: FIRST,
    });

    const { create, update } = mocks.upsert.mock.calls[0][0];
    expect(create.lastCheckedAt).toEqual(FIRST);
    expect(update.lastCheckedAt).toEqual(FIRST);
  });
});

describe("moving the baseline after a change", () => {
  it("replaces the content and moves both timestamps when it already exists", async () => {
    await saveWebsiteSnapshot("source-1", {
      normalizedContent: "the page, differently",
      contentHash: "def456",
      at: LATER,
    });

    const { update } = mocks.upsert.mock.calls[0][0];
    expect(update).toEqual({
      normalizedContent: "the page, differently",
      contentHash: "def456",
      lastCheckedAt: LATER,
      lastChangedAt: LATER,
    });
  });

  /**
   * **Raw HTML is never stored**, and this is where that stays true: the
   * columns written are exactly the four the baseline is made of. A fifth
   * arriving here — the markup, the response headers, anything else the fetch
   * happened to have — would fail this rather than being noticed later, in a
   * database, at a couple of megabytes a row.
   */
  it("writes the four things a baseline is made of and nothing else", async () => {
    await saveWebsiteSnapshot("source-1", {
      normalizedContent: "the page as text",
      contentHash: "abc123",
      at: FIRST,
    });

    const { create, update } = mocks.upsert.mock.calls[0][0];

    expect(Object.keys(create).sort()).toEqual([
      "contentHash",
      "lastCheckedAt",
      "normalizedContent",
      "websiteSourceId",
    ]);
    expect(Object.keys(update).sort()).toEqual([
      "contentHash",
      "lastChangedAt",
      "lastCheckedAt",
      "normalizedContent",
    ]);
  });
});

describe("recording a check that found nothing new", () => {
  /**
   * **Only `lastCheckedAt` moves.** Rewriting identical content would cost a
   * couple of megabytes to say nothing, and moving `lastChangedAt` would lose
   * the one timestamp that answers whether anything has happened lately.
   */
  it("moves when it was last read and leaves the baseline alone", async () => {
    await markWebsiteSnapshotChecked("source-1", LATER);

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { websiteSourceId: "source-1" },
      data: { lastCheckedAt: LATER },
    });
  });

  /**
   * A page that has never changed must still read as never changed after being
   * checked again. Touching `lastChangedAt` here would date a change to the
   * moment somebody looked.
   */
  it("writes nothing but the time it was read", async () => {
    await markWebsiteSnapshotChecked("source-1", LATER);

    const { data } = mocks.updateMany.mock.calls[0][0];
    expect(Object.keys(data)).toEqual(["lastCheckedAt"]);
  });

  it("reports that it landed", async () => {
    expect(await markWebsiteSnapshotChecked("source-1", LATER)).toBe(true);
  });

  /**
   * Nothing has been checked that was never read, so a missing row is a caller
   * that skipped establishing a baseline rather than a state to create one for.
   * It is reported rather than thrown — the caller is a run, and a run decides
   * what its own failures are.
   */
  it("reports that there was nothing to move", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });

    expect(await markWebsiteSnapshotChecked("source-1", LATER)).toBe(false);
  });
});
