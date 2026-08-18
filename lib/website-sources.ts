import "server-only";

import { type DbClient, prisma } from "@/lib/prisma";
import type { WebsiteSource } from "@/types";

type WebsiteSourceRecord = Awaited<
  ReturnType<typeof prisma.websiteSource.findFirstOrThrow>
>;

/**
 * Turns a stored row into the source the rest of the application sees.
 *
 * Named field by field for the same reason `toRoutine` and `toRun` are: a
 * source can reach a client component, so what a column carries outwards is
 * something it opts into rather than something a spread grants it.
 */
function toWebsiteSource(record: WebsiteSourceRecord): WebsiteSource {
  return {
    id: record.id,
    routineId: record.routineId,
    url: record.url,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * The page a worker watches, for the person who owns it.
 *
 * **Scoped to the owner, and the owner is the routine's.** A source has no
 * owner column: `Routine.userId` is the only place that says who anything
 * belongs to, so the tenant condition is a filter through the relation rather
 * than a column on the row. Two places saying it would eventually disagree, and
 * a source pointing at one account while its worker points at another is a
 * state worth making unrepresentable.
 *
 * A worker id is a `cuid` rather than a secret, so an API that answered on the
 * id alone would hand one account's configuration to whoever guessed one.
 *
 * Returns null for both "no source" and "someone else's" — the caller has no
 * business telling those apart, and a `prompt` worker legitimately has none.
 */
export async function getWebsiteSource(
  routineId: string,
  userId: string,
): Promise<WebsiteSource | null> {
  const record = await prisma.websiteSource.findFirst({
    where: { routineId, routine: { userId } },
  });

  return record ? toWebsiteSource(record) : null;
}

/**
 * Attaches a page to a worker that has just been hired.
 *
 * **Create-only, and separate from `saveWebsiteSource` for that reason.** An
 * upsert is the right shape for editing an existing watcher, where "there is
 * already a row" is the ordinary case. Here it would be a bug going quiet: a
 * worker being created has no source yet, so a row already sitting on that
 * `routineId` means something is wrong with how we got here, and a `create`
 * lets the unique constraint say so instead of overwriting whatever was there.
 *
 * **No ownership check, unlike its neighbour, because there is nothing yet to
 * own.** `saveWebsiteSource` is reached from a request naming a worker the
 * caller may not have, so it proves ownership before writing. This is reached
 * only from creation, inside the transaction that is making the routine, with
 * a `routineId` the caller just produced under its own `userId` — re-reading
 * the row to ask who owns it would be asking the question of a row we wrote a
 * statement ago. **That makes the caller responsible for it**: this must not be
 * given a `routineId` that arrived from a form.
 *
 * **The URL is not validated here**, the same as `saveWebsiteSource` — whether
 * an address may be fetched is `lib/watcher`'s question, asked again before
 * every request. What is stored is expected to be canonical already.
 *
 * Takes a client because the routine and its source have to land together or
 * not at all; a routine of kind `website` with nothing to watch is a worker
 * that can only fail.
 */
export async function createWebsiteSource(
  routineId: string,
  url: string,
  client: DbClient = prisma,
): Promise<WebsiteSource> {
  const record = await client.websiteSource.create({ data: { routineId, url } });
  return toWebsiteSource(record);
}

/**
 * Records which page a worker watches, creating the source or replacing its URL.
 *
 * **An upsert on the worker, because a worker watches one page.** Editing a
 * watcher's address is changing where an existing one points rather than adding
 * a second, which is what the unique constraint on `routineId` says in the
 * database and what this says in the application.
 *
 * **The URL is not validated here.** Whether an address may be fetched is
 * `lib/watcher`'s question and is asked again before every request; a
 * repository that also decided it would put that rule in two places and let
 * them drift.
 *
 * Returns null when the worker does not exist or belongs to somebody else,
 * matching `updateRoutine` — the caller reports "not found" either way.
 */
export async function saveWebsiteSource(
  routineId: string,
  userId: string,
  url: string,
): Promise<WebsiteSource | null> {
  // **Ownership is established before anything is written.** `upsert` matches
  // on the unique `routineId` alone — it takes no relation filter — so without
  // this, a request naming someone else's worker would attach a watched page to
  // it. Two statements rather than one is the cost of the owner living in one
  // place.
  const routine = await prisma.routine.findFirst({
    where: { id: routineId, userId },
    select: { id: true },
  });

  if (!routine) {
    return null;
  }

  const record = await prisma.websiteSource.upsert({
    where: { routineId },
    create: { routineId, url },
    update: { url },
  });

  return toWebsiteSource(record);
}
