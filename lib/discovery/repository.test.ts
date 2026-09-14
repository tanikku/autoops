import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which account a discovery worker's search and history belong to, fixed at the
 * repository.
 *
 * **The tenant condition is the whole subject.** A worker id is a `cuid` rather
 * than a secret, so an API answering on the id alone would hand one account's
 * configuration to whoever guessed one — and, for a writer, would attach a
 * search to somebody else's worker.
 *
 * **Neither table stores an owner, so every assertion below is about reaching
 * `Routine.userId`** rather than about matching a column here. That is the
 * point: a column here could disagree with it.
 *
 * What these cannot show is what the database enforces — that `routineId` is
 * unique on a source, that `(routineId, itemKey)` is unique on a seen item, and
 * that deleting a worker takes both with it. Those are constraints in the
 * migration and no amount of mocking Prisma reaches them; they are stated as
 * schema contracts in the phase report instead. What *is* shown here is that
 * the code asks in a way those constraints can answer.
 */

const mocks = vi.hoisted(() => ({
  routineFindFirst: vi.fn(),
  sourceFindFirst: vi.fn(),
  sourceUpsert: vi.fn(),
  seenFindMany: vi.fn(),
  seenCreateMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    routine: { findFirst: mocks.routineFindFirst },
    discoverySource: {
      findFirst: mocks.sourceFindFirst,
      upsert: mocks.sourceUpsert,
    },
    discoverySeenItem: {
      findMany: mocks.seenFindMany,
      createMany: mocks.seenCreateMany,
    },
  },
}));

const {
  getDiscoverySource,
  listRecentSeenKeys,
  recordSeenItems,
  saveDiscoverySource,
} = await import("@/lib/discovery/repository");

const NOW = new Date("2026-09-14T12:00:00.000Z");

const SOURCE_ROW = {
  id: "source-1",
  routineId: "worker-1",
  source: "youtube",
  query: "ハリネズミ",
  maxResults: 5,
  createdAt: NOW,
  updatedAt: NOW,
};

const CANDIDATE = {
  itemKey: "youtube:abc",
  title: "ハリネズミの飼い方",
  author: "もふもふチャンネル",
  url: "https://www.youtube.com/watch?v=abc",
  publishedAt: NOW,
};

beforeEach(() => {
  mocks.routineFindFirst.mockReset().mockResolvedValue({ id: "worker-1" });
  mocks.sourceFindFirst.mockReset().mockResolvedValue(SOURCE_ROW);
  mocks.sourceUpsert.mockReset().mockResolvedValue(SOURCE_ROW);
  mocks.seenFindMany.mockReset().mockResolvedValue([]);
  mocks.seenCreateMany.mockReset().mockResolvedValue({ count: 0 });
});

describe("reading what a worker searches for", () => {
  it("answers the owner", async () => {
    const source = await getDiscoverySource("worker-1", "user-1");

    expect(source?.query).toBe("ハリネズミ");
    expect(source?.maxResults).toBe(5);
  });

  /**
   * **Scoped through the relation, not by a column here.** The filter has to
   * name both the worker and whose it is; naming the worker alone would answer
   * on a guessable id.
   */
  it("asks for the worker and whose it is", async () => {
    await getDiscoverySource("worker-1", "user-1");

    expect(mocks.sourceFindFirst).toHaveBeenCalledWith({
      where: { routineId: "worker-1", routine: { userId: "user-1" } },
    });
  });

  /**
   * Somebody else's worker and a worker that does not exist are the same
   * answer: the caller has no business telling them apart.
   */
  it("answers nothing for a worker that is not this account's", async () => {
    mocks.sourceFindFirst.mockResolvedValue(null);

    expect(await getDiscoverySource("worker-1", "user-2")).toBeNull();
  });

  /**
   * **The provider is not narrowed here.** A row holding a source this
   * deployment does not implement is something for the caller to notice, not
   * something for a read to crash on.
   */
  it("hands the stored provider on without judging it", async () => {
    mocks.sourceFindFirst.mockResolvedValue({ ...SOURCE_ROW, source: "vimeo" });

    expect((await getDiscoverySource("worker-1", "user-1"))?.source).toBe(
      "vimeo",
    );
  });
});

describe("saving what a worker searches for", () => {
  const INPUT = { source: "youtube", query: "ハリネズミ", maxResults: 5 };

  /**
   * **The ownership read is not optional, and this is why.** `upsert` matches
   * on the unique `routineId` alone and takes no relation filter — so the write
   * itself cannot carry the tenant condition, and something before it has to.
   */
  it("establishes the owner before writing anything", async () => {
    await saveDiscoverySource("worker-1", "user-1", INPUT);

    expect(mocks.routineFindFirst).toHaveBeenCalledWith({
      where: { id: "worker-1", userId: "user-1" },
      select: { id: true },
    });
    expect(mocks.sourceUpsert).toHaveBeenCalledTimes(1);
  });

  it("writes the search on the worker it was given", async () => {
    await saveDiscoverySource("worker-1", "user-1", INPUT);

    expect(mocks.sourceUpsert).toHaveBeenCalledWith({
      where: { routineId: "worker-1" },
      create: { routineId: "worker-1", ...INPUT },
      update: INPUT,
    });
  });

  /**
   * **The write never happens.** Not refused afterwards, not rolled back —
   * `upsert` is not reached at all, because reaching it would mean a foreign
   * worker briefly had a search attached to it.
   */
  it("writes nothing at all for somebody else's worker", async () => {
    mocks.routineFindFirst.mockResolvedValue(null);

    const saved = await saveDiscoverySource("worker-1", "user-2", INPUT);

    expect(saved).toBeNull();
    expect(mocks.sourceUpsert).not.toHaveBeenCalled();
  });
});

describe("the keys a worker has already chosen", () => {
  it("asks for this worker's history, as this account", async () => {
    await listRecentSeenKeys("worker-1", "user-1", 50);

    expect(mocks.seenFindMany).toHaveBeenCalledWith({
      where: { routineId: "worker-1", routine: { userId: "user-1" } },
      orderBy: [{ selectedAt: "desc" }, { id: "desc" }],
      take: 50,
      select: { itemKey: true },
    });
  });

  /**
   * **Never the worker alone.** A history scoped on the id only would let one
   * account's exclusion set be read by whoever guessed a worker id.
   */
  it("never scopes on the worker alone", async () => {
    await listRecentSeenKeys("worker-1", "user-1", 50);

    const where = mocks.seenFindMany.mock.calls[0][0].where as Record<
      string,
      unknown
    >;

    expect(Object.keys(where).sort()).toEqual(["routine", "routineId"]);
    expect(where.routine).toEqual({ userId: "user-1" });
  });

  /**
   * **Bounded, because the exclusion set is compared against one run.** An
   * unbounded read would grow with the worker's age and be spent almost
   * entirely on items no search would surface again.
   */
  it("reaches back only as far as it was asked to", async () => {
    await listRecentSeenKeys("worker-1", "user-1", 20);

    expect(mocks.seenFindMany.mock.calls[0][0].take).toBe(20);
  });

  it("answers with a set, so a lookup is one question", async () => {
    mocks.seenFindMany.mockResolvedValue([
      { itemKey: "youtube:a" },
      { itemKey: "youtube:b" },
    ]);

    const seen = await listRecentSeenKeys("worker-1", "user-1", 50);

    expect(seen.has("youtube:a")).toBe(true);
    expect(seen.has("youtube:c")).toBe(false);
    expect(seen.size).toBe(2);
  });

  it("answers with an empty set for a worker that has chosen nothing", async () => {
    const seen = await listRecentSeenKeys("worker-1", "user-1", 50);

    expect(seen.size).toBe(0);
  });
});

describe("writing down what a run chose", () => {
  it("records each choice against the worker that made it", async () => {
    await recordSeenItems("worker-1", [CANDIDATE]);

    expect(mocks.seenCreateMany).toHaveBeenCalledWith({
      data: [
        {
          routineId: "worker-1",
          itemKey: "youtube:abc",
          title: "ハリネズミの飼い方",
          author: "もふもふチャンネル",
          url: "https://www.youtube.com/watch?v=abc",
          publishedAt: NOW,
        },
      ],
      skipDuplicates: true,
    });
  });

  /**
   * **A conflict here is the constraint working, not a failure.** Two runs of
   * the same worker overlapping can both choose the same item; failing the run
   * over it would turn a duplicate row into a duplicate failure, which is worse
   * and less true.
   */
  it("lets the unique constraint absorb a second run's overlap", async () => {
    mocks.seenCreateMany.mockResolvedValue({ count: 1 });

    const written = await recordSeenItems("worker-1", [
      CANDIDATE,
      { ...CANDIDATE, itemKey: "youtube:def" },
    ]);

    expect(mocks.seenCreateMany.mock.calls[0][0].skipDuplicates).toBe(true);
    expect(written).toBe(1);
  });

  /** Nothing chosen is an ordinary outcome, and it costs no statement. */
  it("writes nothing when a run chose nothing", async () => {
    expect(await recordSeenItems("worker-1", [])).toBe(0);
    expect(mocks.seenCreateMany).not.toHaveBeenCalled();
  });

  /**
   * **The caller supplies the client so this can sit inside a transaction**,
   * which is where it belongs: a run recorded as completed whose choices were
   * not written down would offer the same items again tomorrow.
   */
  it("writes through whichever client it was handed", async () => {
    const tx = { discoverySeenItem: { createMany: vi.fn().mockResolvedValue({ count: 1 }) } };

    await recordSeenItems(
      "worker-1",
      [CANDIDATE],
      tx as unknown as Parameters<typeof recordSeenItems>[2],
    );

    expect(tx.discoverySeenItem.createMany).toHaveBeenCalledTimes(1);
    expect(mocks.seenCreateMany).not.toHaveBeenCalled();
  });
});

/**
 * Two accounts, and nothing of one reaching the other.
 *
 * The isolation is the same property the queries above assert one at a time;
 * what these add is the pair, because a filter can be right in isolation and
 * still be applied to the wrong argument.
 */
describe("two accounts", () => {
  it("reads each account's search with its own owner in the filter", async () => {
    await getDiscoverySource("worker-1", "user-1");
    await getDiscoverySource("worker-2", "user-2");

    expect(mocks.sourceFindFirst.mock.calls[0][0].where).toEqual({
      routineId: "worker-1",
      routine: { userId: "user-1" },
    });
    expect(mocks.sourceFindFirst.mock.calls[1][0].where).toEqual({
      routineId: "worker-2",
      routine: { userId: "user-2" },
    });
  });

  it("reads each account's history with its own owner in the filter", async () => {
    await listRecentSeenKeys("worker-1", "user-1", 50);
    await listRecentSeenKeys("worker-2", "user-2", 50);

    expect(mocks.seenFindMany.mock.calls[0][0].where).toEqual({
      routineId: "worker-1",
      routine: { userId: "user-1" },
    });
    expect(mocks.seenFindMany.mock.calls[1][0].where).toEqual({
      routineId: "worker-2",
      routine: { userId: "user-2" },
    });
  });

  /**
   * **The same item chosen by two workers is two rows, not a conflict.** The
   * unique constraint is on the pair, so one account having seen something says
   * nothing about another — which is what keeps an exclusion set private as
   * well as correct.
   */
  it("records the same item for two workers without either excluding the other", async () => {
    await recordSeenItems("worker-1", [CANDIDATE]);
    await recordSeenItems("worker-2", [CANDIDATE]);

    expect(mocks.seenCreateMany.mock.calls[0][0].data[0].routineId).toBe(
      "worker-1",
    );
    expect(mocks.seenCreateMany.mock.calls[1][0].data[0].routineId).toBe(
      "worker-2",
    );
  });
});
