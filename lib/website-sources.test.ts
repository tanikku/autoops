import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which account a watched page belongs to, fixed at the repository.
 *
 * **The tenant condition is the whole subject here.** A worker id is a `cuid`
 * rather than a secret, so an API that answered on the id alone would hand one
 * account's configuration to whoever guessed one — and, worse for a writer,
 * would attach a watched page to somebody else's worker.
 *
 * **The owner is the routine's, and a source stores none of its own.** Both
 * shapes below are therefore about reaching `Routine.userId`, not about
 * matching a column here — which is the point, because a column here could
 * disagree with it.
 *
 * What these cannot show is what the database enforces: that `routineId` is
 * unique, that two workers may watch the same URL, and that deleting a worker
 * takes its source with it. Those are constraints in the migration, and no
 * amount of mocking Prisma reaches them — they are verified against a local
 * database and listed as schema contracts in the sprint report instead.
 */

const mocks = vi.hoisted(() => ({
  routineFindFirst: vi.fn(),
  sourceFindFirst: vi.fn(),
  sourceUpsert: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    routine: { findFirst: mocks.routineFindFirst },
    websiteSource: {
      findFirst: mocks.sourceFindFirst,
      upsert: mocks.sourceUpsert,
    },
  },
}));

const { getWebsiteSource, saveWebsiteSource } = await import(
  "@/lib/website-sources"
);

const NOW = new Date("2026-08-13T12:00:00.000Z");

const SOURCE_ROW = {
  id: "source-1",
  routineId: "worker-1",
  url: "https://example.com/",
  createdAt: NOW,
  updatedAt: NOW,
};

beforeEach(() => {
  mocks.routineFindFirst.mockReset().mockResolvedValue({ id: "worker-1" });
  mocks.sourceFindFirst.mockReset().mockResolvedValue(SOURCE_ROW);
  mocks.sourceUpsert.mockReset().mockResolvedValue(SOURCE_ROW);
});

describe("reading the page a worker watches", () => {
  /**
   * **The tenant condition reaches through the routine.** There is no owner
   * column to match on, and that is deliberate: the routine is the single place
   * that says who anything belongs to.
   */
  it("scopes the read by who owns the worker", async () => {
    await getWebsiteSource("worker-1", "user-1");

    expect(mocks.sourceFindFirst).toHaveBeenCalledWith({
      where: { routineId: "worker-1", routine: { userId: "user-1" } },
    });
  });

  it("returns null for a worker that belongs to somebody else", async () => {
    mocks.sourceFindFirst.mockResolvedValue(null);

    expect(await getWebsiteSource("worker-1", "someone-else")).toBeNull();
  });

  /** A prompt worker legitimately has none, and says so the same way. */
  it("returns null for a worker that watches nothing", async () => {
    mocks.sourceFindFirst.mockResolvedValue(null);

    expect(await getWebsiteSource("worker-1", "user-1")).toBeNull();
  });

  it("names the fields it hands back rather than spreading the row", async () => {
    mocks.sourceFindFirst.mockResolvedValue({
      ...SOURCE_ROW,
      somethingAddedLater: "should not travel",
    });

    expect(await getWebsiteSource("worker-1", "user-1")).toEqual(SOURCE_ROW);
  });

  it("carries no owner of its own", async () => {
    const source = await getWebsiteSource("worker-1", "user-1");

    expect(source).not.toHaveProperty("userId");
  });
});

describe("saving the page a worker watches", () => {
  it("checks who owns the worker before writing anything", async () => {
    await saveWebsiteSource("worker-1", "user-1", "https://example.com/");

    expect(mocks.routineFindFirst).toHaveBeenCalledWith({
      where: { id: "worker-1", userId: "user-1" },
      select: { id: true },
    });

    expect(
      mocks.routineFindFirst.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.sourceUpsert.mock.invocationCallOrder[0]);
  });

  /**
   * **The case the ownership read exists for.** `upsert` matches on the unique
   * `routineId` alone and cannot carry a tenant condition of its own, so
   * without the check above, naming somebody else's worker would attach a
   * watched page to it.
   */
  it("writes nothing for a worker that is not the caller's", async () => {
    mocks.routineFindFirst.mockResolvedValue(null);

    expect(
      await saveWebsiteSource("worker-1", "intruder", "https://evil.example/"),
    ).toBeNull();

    expect(mocks.sourceUpsert).not.toHaveBeenCalled();
  });

  it("attaches the source to the worker, and only replaces the URL after", async () => {
    await saveWebsiteSource("worker-1", "user-1", "https://example.com/");

    expect(mocks.sourceUpsert).toHaveBeenCalledWith({
      where: { routineId: "worker-1" },
      create: { routineId: "worker-1", url: "https://example.com/" },
      update: { url: "https://example.com/" },
    });
  });

  /**
   * **No owner is written, because a source has none to write.** A copy of the
   * tenant key here could end up naming a different account from the routine's,
   * and there would be no way to tell which of the two was right.
   */
  it("stores no owner on the source itself", async () => {
    await saveWebsiteSource("worker-1", "user-1", "https://example.com/");

    const { create, update } = mocks.sourceUpsert.mock.calls[0][0];
    expect(Object.keys(create).sort()).toEqual(["routineId", "url"]);
    expect(Object.keys(update)).toEqual(["url"]);
  });

  /**
   * Whether an address may be fetched is `lib/watcher`'s question, asked again
   * before every request. Deciding it here as well would put the rule in two
   * places and let them disagree.
   */
  it("does not decide whether the address is safe to visit", async () => {
    await saveWebsiteSource("worker-1", "user-1", "http://localhost/");

    expect(mocks.sourceUpsert).toHaveBeenCalled();
  });
});
