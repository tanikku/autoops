import "server-only";

import { type DbClient, prisma } from "@/lib/prisma";
import type { WebsiteSnapshot } from "@/types";

/**
 * The baseline moved, or was created, while this run was working on it.
 *
 * **Somebody else got there first.** The row a run read at the start is not the
 * row it is about to write over, which means the change it decided to act on
 * has already been acted on — or has been replaced by a newer one. Writing
 * anyway would overwrite a state this run never saw.
 *
 * The same minimal shape as the other execution errors: one class and one
 * predicate. The message says nothing about the content, the digest, or the
 * address — a conflict is about timing, and none of that would help.
 */
export class WebsiteStateConflictError extends Error {
  readonly websiteSourceId: string;

  constructor(websiteSourceId: string) {
    super("Website state changed during execution.");
    this.name = "WebsiteStateConflictError";
    this.websiteSourceId = websiteSourceId;
  }
}

/** Whether a rejection means the baseline moved underneath a run. */
export function isWebsiteStateConflict(error: unknown): boolean {
  return error instanceof WebsiteStateConflictError;
}

/** Prisma's code for a unique constraint that would have been broken. */
const UNIQUE_VIOLATION = "P2002";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/**
 * The baseline a watched page is compared against.
 *
 * **These are execution-path internals.** They are keyed on a source id rather
 * than on an owner because the only thing that calls them is a run, and a run
 * is performed on behalf of the platform — the same standing `getDueWorkers`
 * and `claimRoutineSlot` have. Nothing here answers a signed-in user, and
 * **nothing here should be called from a server action**: the way to reach a
 * source id from a request is `getWebsiteSource`, which takes the owner.
 *
 * If a screen ever needs to show a snapshot, it needs a tenant-scoped read of
 * its own rather than one of these — which is why none of them takes an
 * optional `userId` that a caller could forget.
 */

type WebsiteSnapshotRecord = Awaited<
  ReturnType<typeof prisma.websiteSnapshot.findFirstOrThrow>
>;

/** Named field by field, as every other row-to-domain conversion here is. */
function toWebsiteSnapshot(record: WebsiteSnapshotRecord): WebsiteSnapshot {
  return {
    id: record.id,
    websiteSourceId: record.websiteSourceId,
    normalizedContent: record.normalizedContent,
    contentHash: record.contentHash,
    lastCheckedAt: record.lastCheckedAt,
    lastChangedAt: record.lastChangedAt,
    createdAt: record.createdAt,
  };
}

/**
 * What the page looked like last time, or null if it has never been read.
 *
 * **Null is the first-run state and the only one.** A source with no snapshot
 * has no baseline, which is a different thing from a baseline that happens to
 * be empty — a page that legitimately serves nothing would otherwise be
 * indistinguishable from one that has never been fetched.
 */
export async function getWebsiteSnapshot(
  websiteSourceId: string,
  client: DbClient = prisma,
): Promise<WebsiteSnapshot | null> {
  const record = await client.websiteSnapshot.findUnique({
    where: { websiteSourceId },
  });

  return record ? toWebsiteSnapshot(record) : null;
}

/**
 * Establishes the first baseline for a source, and only the first.
 *
 * **A create, never an upsert**, which is the whole difference between this and
 * `saveWebsiteSnapshot`. Two runs can decide "there is no baseline" at the same
 * moment; an upsert would let the second quietly write over the first, and the
 * change the first one was about to report would be gone. A create lets the
 * unique constraint on `websiteSourceId` decide, and the loser is told.
 *
 * **`lastChangedAt` is left unset.** A first read is not a change — there was
 * nothing to differ from — and dating one to the moment watching started would
 * report it to somebody who had not been watching yet.
 *
 * A unique violation comes back as a conflict rather than as success. Turning
 * it into "fine, it exists now" would be the upsert again, wearing a different
 * hat.
 */
export async function createWebsiteSnapshotBaseline(
  websiteSourceId: string,
  baseline: WebsiteSnapshotBaseline,
  client: DbClient = prisma,
): Promise<WebsiteSnapshot> {
  try {
    const record = await client.websiteSnapshot.create({
      data: {
        websiteSourceId,
        normalizedContent: baseline.normalizedContent,
        contentHash: baseline.contentHash,
        lastCheckedAt: baseline.at,
      },
    });

    return toWebsiteSnapshot(record);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new WebsiteStateConflictError(websiteSourceId);
    }

    throw error;
  }
}

/**
 * Records that the page was read, but only while the baseline is still the one
 * the caller compared against.
 *
 * **The condition is what makes the write safe to combine with anything else.**
 * A run reads a baseline, spends some seconds fetching and comparing, and then
 * writes; in between, another run may have advanced it. Matching on the content
 * and the digest that were read means the write lands on the state the decision
 * was made about, or it does not land at all.
 *
 * **Both, not just the digest.** A digest is a shorthand for the content, and
 * the comparison that produced this decision insisted on the two agreeing
 * (`detectWebsiteChange`). The condition here holds the database to the same
 * standard rather than a weaker one.
 *
 * **Only `lastCheckedAt` moves.** The content, the digest and `lastChangedAt`
 * are left exactly as they were: this says the page was looked at, and nothing
 * about it having changed.
 *
 * `false` means somebody else moved it. It is reported rather than thrown so
 * that the caller — which is inside a transaction it may want to abandon —
 * decides what that means.
 */
export async function markWebsiteSnapshotCheckedIfCurrent(
  websiteSourceId: string,
  expected: Pick<WebsiteSnapshot, "normalizedContent" | "contentHash">,
  at: Date,
  client: DbClient = prisma,
): Promise<boolean> {
  const { count } = await client.websiteSnapshot.updateMany({
    where: {
      websiteSourceId,
      contentHash: expected.contentHash,
      normalizedContent: expected.normalizedContent,
    },
    data: { lastCheckedAt: at },
  });

  // Anything but exactly one row is not a success. `websiteSourceId` is unique
  // so two is impossible, and treating it as fine anyway would mean the one
  // number that says "this landed where it was meant to" had stopped being
  // checked.
  return count === 1;
}

/** What a baseline is made of. Every field is known by the time it is set. */
export type WebsiteSnapshotBaseline = {
  normalizedContent: string;
  contentHash: string;
  /** When the page was read. */
  at: Date;
};

/**
 * Makes what the page says now the thing future reads are compared against.
 *
 * **The two branches are two different events, and the timestamps say which.**
 *
 * - No row yet — the first successful read. `lastChangedAt` is left null,
 *   because establishing a baseline is not observing a change: there was
 *   nothing to differ from, and dating a change to the moment watching started
 *   would report one to somebody who had not been watching yet.
 * - A row already — the content differed. `lastChangedAt` moves to now, which
 *   is what it is for.
 *
 * That mapping is exact rather than convenient: this is called on a first read
 * and on a change, and on nothing else. **A check that found no change uses
 * `markWebsiteSnapshotChecked`**, which is a different write for a different
 * event — calling this one with identical content would date a change that did
 * not happen.
 *
 * **When it runs is a policy that does not live here.** The rule that a change
 * is only baselined once the work it triggered has succeeded belongs to
 * execution; a repository that advanced on its own would be deciding it.
 *
 * **Execution does not use this.** Its create branch is an upsert, and an
 * upsert cannot tell a first baseline from one another run has just written —
 * see `createWebsiteSnapshotBaseline`, which execution uses instead.
 */
export async function saveWebsiteSnapshot(
  websiteSourceId: string,
  baseline: WebsiteSnapshotBaseline,
): Promise<WebsiteSnapshot> {
  const record = await prisma.websiteSnapshot.upsert({
    where: { websiteSourceId },
    create: {
      websiteSourceId,
      normalizedContent: baseline.normalizedContent,
      contentHash: baseline.contentHash,
      lastCheckedAt: baseline.at,
    },
    update: {
      normalizedContent: baseline.normalizedContent,
      contentHash: baseline.contentHash,
      lastCheckedAt: baseline.at,
      lastChangedAt: baseline.at,
    },
  });

  return toWebsiteSnapshot(record);
}

/**
 * Records that the page was read and had not changed.
 *
 * **Only `lastCheckedAt` moves**, which is the whole difference between the two
 * writes in this file: the content and the digest stay as they were, and
 * `lastChangedAt` keeps pointing at whenever the page last actually differed —
 * or stays null, if it never has. Rewriting the content with an identical copy
 * would cost a couple of megabytes to say nothing, and moving the other
 * timestamp would lose the one thing that answers "has anything happened
 * lately".
 *
 * It is an update rather than an upsert: nothing has been checked that was
 * never read, so a missing row here is a caller that skipped establishing a
 * baseline.
 *
 * **Execution does not use this either.** It matches on the source alone, so it
 * would write over a baseline another run had advanced in the meantime —
 * `markWebsiteSnapshotCheckedIfCurrent` is the one execution calls.
 */
export async function markWebsiteSnapshotChecked(
  websiteSourceId: string,
  at: Date,
): Promise<boolean> {
  const { count } = await prisma.websiteSnapshot.updateMany({
    where: { websiteSourceId },
    data: { lastCheckedAt: at },
  });

  return count === 1;
}
