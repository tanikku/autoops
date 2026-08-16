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
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    websiteSnapshot: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
      updateMany: mocks.updateMany,
    },
  },
}));

const {
  getWebsiteSnapshot,
  markWebsiteSnapshotChecked,
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
