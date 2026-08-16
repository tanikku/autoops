import "server-only";

import { prisma } from "@/lib/prisma";
import type { WebsiteSnapshot } from "@/types";

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
): Promise<WebsiteSnapshot | null> {
  const record = await prisma.websiteSnapshot.findUnique({
    where: { websiteSourceId },
  });

  return record ? toWebsiteSnapshot(record) : null;
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
