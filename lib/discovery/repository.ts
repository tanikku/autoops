import "server-only";

import { type DbClient, prisma } from "@/lib/prisma";
import type { DiscoveryCandidate } from "@/lib/discovery/types";

/**
 * Which account a discovery worker's configuration and history belong to, fixed
 * here.
 *
 * **Neither table stores an owner, and that is the design.** `Routine.userId`
 * is the only place in Koqentra that says who anything belongs to, so every
 * query below reaches it through the relation rather than matching a column on
 * the row. A second column saying it would eventually disagree with the first,
 * and a source pointing at one account while its worker points at another is a
 * state worth making unrepresentable.
 *
 * A worker id is a `cuid` rather than a secret, so an API answering on the id
 * alone would hand one account's configuration to whoever guessed one — and,
 * for a writer, would attach a search to somebody else's worker.
 *
 * **Nothing calls any of this yet.** `routineKinds` does not contain
 * `discovery`, so no worker can be saved as one. This is the read and write
 * layer being settled before the execution that will use it.
 */

type DiscoverySourceRecord = Awaited<
  ReturnType<typeof prisma.discoverySource.findFirstOrThrow>
>;

/** What a discovery worker is configured to look for. */
export type DiscoverySourceView = {
  id: string;
  routineId: string;
  source: string;
  query: string;
  maxResults: number;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Turns a stored row into what the rest of the application sees.
 *
 * Named field by field for the same reason `toWebsiteSource` is: a spread
 * grants every column a future migration adds, and what leaves this layer
 * should be something it opted into.
 *
 * **`source` stays a string here.** Narrowing it to `DiscoverySourceKind` is
 * the caller's decision, because a row holding a provider this deployment does
 * not know about is something to notice rather than something to crash on.
 */
function toDiscoverySource(record: DiscoverySourceRecord): DiscoverySourceView {
  return {
    id: record.id,
    routineId: record.routineId,
    source: record.source,
    query: record.query,
    maxResults: record.maxResults,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * What a worker searches for, for the person who owns it.
 *
 * Returns null for both "no source" and "somebody else's" — the caller has no
 * business telling those apart, and a worker of another kind legitimately has
 * none.
 */
export async function getDiscoverySource(
  routineId: string,
  userId: string,
  client: DbClient = prisma,
): Promise<DiscoverySourceView | null> {
  const record = await client.discoverySource.findFirst({
    where: { routineId, routine: { userId } },
  });

  return record ? toDiscoverySource(record) : null;
}

/**
 * Attaches a search to a worker, or changes the one it has.
 *
 * **Ownership is established before anything is written, in a separate
 * statement.** `upsert` matches on the unique `routineId` alone and takes no
 * relation filter, so without the read above, a request naming somebody else's
 * worker would attach a search to it. Two statements rather than one is the
 * cost of the owner living in one place — the same cost `saveWebsiteSource`
 * pays, for the same reason.
 *
 * Returns null when the worker is not this account's, which is the same answer
 * as "there is no such worker".
 */
export async function saveDiscoverySource(
  routineId: string,
  userId: string,
  input: { source: string; query: string; maxResults: number },
  client: DbClient = prisma,
): Promise<DiscoverySourceView | null> {
  const routine = await client.routine.findFirst({
    where: { id: routineId, userId },
    select: { id: true },
  });

  if (!routine) {
    return null;
  }

  const record = await client.discoverySource.upsert({
    where: { routineId },
    create: { routineId, ...input },
    update: input,
  });

  return toDiscoverySource(record);
}

/**
 * The keys this worker has already chosen, newest first.
 *
 * **Bounded, and the bound is the caller's.** The exclusion set is compared
 * against one run's candidates, so it needs to reach back far enough to cover
 * what a provider is likely to return again — not to the beginning of time. An
 * unbounded read would grow with the worker's age and be spent almost entirely
 * on items no search would surface again.
 *
 * Keys only: what is wanted is whether something has been seen, and the title
 * it had when it was chosen answers a different question.
 */
export async function listRecentSeenKeys(
  routineId: string,
  userId: string,
  limit: number,
  client: DbClient = prisma,
): Promise<Set<string>> {
  const rows = await client.discoverySeenItem.findMany({
    where: { routineId, routine: { userId } },
    orderBy: [{ selectedAt: "desc" }, { id: "desc" }],
    take: limit,
    select: { itemKey: true },
  });

  return new Set(rows.map((row) => row.itemKey));
}

/**
 * Writes down what a run chose.
 *
 * **`skipDuplicates`, because a conflict here is not an error.** Two runs of
 * the same worker overlapping — a lease that lapsed, a hand-started run beside
 * a scheduled one — can both choose the same item, and the unique constraint on
 * `(routineId, itemKey)` is what stops the second from recording it twice. That
 * is the constraint doing its job; failing the whole run over it would turn a
 * duplicate row into a duplicate *failure*, which is worse and less true.
 *
 * **Takes a client so the caller can put this in a transaction**, which is
 * where it belongs: a run recorded as completed whose choices were not written
 * down would offer the same items again tomorrow, and nothing on any screen
 * would say why.
 *
 * Returns how many rows were actually created, which can be fewer than were
 * passed when a concurrent run got there first.
 */
export async function recordSeenItems(
  routineId: string,
  candidates: readonly DiscoveryCandidate[],
  client: DbClient = prisma,
): Promise<number> {
  if (candidates.length === 0) {
    return 0;
  }

  const { count } = await client.discoverySeenItem.createMany({
    data: candidates.map((candidate) => ({
      routineId,
      itemKey: candidate.itemKey,
      title: candidate.title,
      author: candidate.author,
      url: candidate.url,
      publishedAt: candidate.publishedAt,
    })),
    skipDuplicates: true,
  });

  return count;
}
