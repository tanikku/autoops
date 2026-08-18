"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getRoutineForEdit, updateRoutine } from "@/lib/routines";
import { calculateNextRunAt } from "@/lib/schedule";
import { requireUserId } from "@/lib/session";
import { getUserTimezone } from "@/lib/users";
import { isWatcherError } from "@/lib/watcher/errors";
import { parseWatchUrl } from "@/lib/watcher/url";
import { deleteWebsiteSnapshot } from "@/lib/website-snapshots";
import { getWebsiteSource, updateWebsiteSourceUrl } from "@/lib/website-sources";
import {
  hasWorkerFormErrors,
  readWorkerForm,
  summarizeWorkerFormErrors,
  validateWorkerFormForKind,
  type WorkerFieldErrors,
  type WorkerFormInput,
} from "@/lib/worker-input";
import type { ActionResult, RoutineInput } from "@/types";

/** Said the same way whichever rule the address broke. See the hire action. */
const INVALID_WEBSITE_URL =
  "Enter a full website address, like https://example.com/news.";

/**
 * Abandons the transaction because the worker stopped existing during it.
 *
 * **Not an error taxonomy**, and deliberately not exported: a transaction is
 * abandoned by throwing, and this exists only so that the catch outside can
 * tell "somebody deleted this worker" from "the database refused the write" and
 * say the right one. Both leave the account exactly as it was.
 */
class RoutineVanished extends Error {}

/**
 * A rejected submission carries the values and the per-field messages back.
 *
 * React resets a form once its action settles, so without the values the
 * fields would fall back to the stored worker and everything the user typed
 * would be lost to a missing name. The errors let each field say what is wrong
 * with it, next to the input.
 */
export type UpdateRoutineState =
  | (ActionResult & { values?: WorkerFormInput; errors?: WorkerFieldErrors })
  | null;

export async function updateRoutineAction(
  id: string,
  _prevState: UpdateRoutineState,
  formData: FormData,
): Promise<UpdateRoutineState> {
  const userId = await requireUserId();

  // Reading through the tenant-scoped query means another owner's worker is
  // indistinguishable from one that does not exist.
  //
  // **And the kind comes from here, not from the form.** What a worker is was
  // decided when it was hired; a submission saying otherwise is either a stale
  // form or an attempt to convert one, and this reads past both. `getRoutine`
  // would answer with a display default for a kind it cannot read — see
  // `getRoutineForEdit` for why a mutation must not accept that.
  const existing = await getRoutineForEdit(id, userId);
  if (!existing) {
    notFound();
  }

  const website = existing.kind === "website";

  // **A website worker with no source cannot be saved as anything.** Rendering
  // it as a prompt worker would be the conversion this whole boundary refuses,
  // performed by accident, and saving that form would make it permanent. The
  // state should not exist; the answer to finding it is to change nothing.
  const source = website ? await getWebsiteSource(id, userId) : null;
  if (website && !source) {
    return {
      status: "error",
      message: "This worker has no watched page, so it cannot be saved.",
    };
  }

  const input = readWorkerForm(formData);

  // An existing worker falls back to what it already had: an unreadable value
  // must not quietly reset a running worker to a draft.
  //
  // **Worked out before validation, because validation reads them.** A
  // submission that leaves the status out lands on whatever the worker already
  // is, so a rule about active workers has to be asked about that value rather
  // than about the absent one. Both of these are pure.
  const status = input.status ?? existing.status;
  const frequency = input.frequency ?? existing.frequency;

  const errors = validateWorkerFormForKind(
    input,
    { status, frequency },
    existing.kind,
  );
  if (hasWorkerFormErrors(errors)) {
    return {
      status: "error",
      message: summarizeWorkerFormErrors(errors),
      values: input,
      errors,
    };
  }

  // **Parsed before anything is written, and never inside the transaction.**
  // Only syntax is decided here, the same as when the worker was hired:
  // nothing is resolved or requested, and whether the address may be fetched is
  // asked again on every run.
  let canonicalUrl: string | null = null;
  if (website) {
    try {
      canonicalUrl = parseWatchUrl(input.websiteUrl).toString();
    } catch (error) {
      if (!isWatcherError(error)) {
        throw error;
      }

      const urlErrors: WorkerFieldErrors = { websiteUrl: INVALID_WEBSITE_URL };

      return {
        status: "error",
        message: summarizeWorkerFormErrors(urlErrors),
        values: input,
        errors: urlErrors,
      };
    }
  }

  // **Canonical against canonical, never the strings as typed.** What is stored
  // is what `parseWatchUrl` produced, so comparing raw input to it would call
  // `https://example.com/news#section` a different page from the one already
  // being watched — and throwing away a baseline over a fragment that is never
  // even sent is a change nobody made.
  //
  // Null means the page being watched is the same one, which is also what a
  // prompt worker looks like from here: in both cases there is nothing about a
  // watched page to write.
  const urlChange =
    source !== null && canonicalUrl !== null && canonicalUrl !== source.url
      ? { sourceId: source.id, url: canonicalUrl }
      : null;

  // A time of day only means anything alongside a cadence, and a weekday only
  // alongside a week: a manual worker has no slot to place either in, and a
  // daily one runs on every day there is.
  const runAtMinutes = frequency === "manual" ? null : input.runAtMinutes;
  const runAtWeekday = frequency === "weekly" ? input.runAtWeekday : null;
  const runAtDay = frequency === "monthly" ? input.runAtDay : null;
  const timezone = await getUserTimezone(userId);

  // Any part of the schedule changing invalidates the pending slot: a worker
  // switched to `manual` must stop being due, one switched away from it needs a
  // first slot, and a worker moved from Monday to Wednesday should not run on
  // Monday once more first. Leaving all of it alone keeps the slot, so editing
  // a name or prompt never shifts the schedule.
  const scheduleChanged =
    frequency !== existing.frequency ||
    runAtMinutes !== existing.runAtMinutes ||
    runAtWeekday !== existing.runAtWeekday ||
    runAtDay !== existing.runAtDay;

  // **Only a changed schedule writes the column.** Writing back the value read
  // at the top of this action would look harmless — it is the same value — but
  // the dispatcher may have claimed that slot in between, and restoring the old
  // one hands the worker a slot it has already been given. It would then run a
  // second time for a slot that no longer exists, which is exactly what
  // `claimRoutineSlot` was added to prevent. Leaving the field out of the
  // update is what makes "editing a name never shifts the schedule" structural
  // rather than merely intended.
  const scheduleUpdate = scheduleChanged
    ? {
        nextRunAt: calculateNextRunAt({
          frequency,
          runAtMinutes,
          runAtWeekday,
          runAtDay,
          timezone,
        }),
      }
    : {};

  const update: Partial<RoutineInput> = {
    name: input.name,
    description: input.description,
    prompt: input.prompt,
    status,
    frequency,
    runAtMinutes,
    runAtWeekday,
    runAtDay,
    ...scheduleUpdate,
  };

  let saved;
  try {
    if (urlChange === null) {
      // **Everything else is one write, including editing a website worker.**
      // A name, a cadence, or new instructions say nothing about the page being
      // watched, so nothing about the page is touched — which is what keeps a
      // worker's baseline from being spent on a typo in its description.
      saved = await updateRoutine(id, update, userId);
    } else {
      // **The address and the baseline move together or not at all.** A
      // baseline belongs to the page it was taken from: left behind on a worker
      // now pointed somewhere else, the next run would compare two unrelated
      // documents and hand the model the whole of one as a change. Writing them
      // separately would make that state reachable whenever the second write
      // failed — and it would look like an ordinary worker.
      saved = await prisma.$transaction(async (tx) => {
        const routine = await updateRoutine(id, update, userId, tx);
        if (!routine) {
          throw new RoutineVanished();
        }

        if (!(await updateWebsiteSourceUrl(id, userId, urlChange.url, tx))) {
          throw new RoutineVanished();
        }

        // Nothing to delete is the ordinary case for a worker that has not run
        // yet, and it is a success: see `deleteWebsiteSnapshot`.
        await deleteWebsiteSnapshot(urlChange.sourceId, tx);

        return routine;
      });
    }
  } catch (error) {
    if (error instanceof RoutineVanished) {
      return { status: "error", message: "Worker not found.", values: input };
    }

    console.error("[worker] update failed", error);
    return {
      status: "error",
      message: "Could not save the worker.",
      values: input,
    };
  }

  // **No row matched, which is not the same as no error.** `updateRoutine`
  // returns null when its `WHERE` found nothing — the worker was deleted
  // between the read at the top of this action and the write above, or it was
  // never this owner's. Nothing was saved, so saying it was would be the one
  // outcome worse than either: the form clears, the toast says the change
  // landed, and it did not. `deleteWorkerAction` already checks its own
  // count for the same reason.
  if (!saved) {
    return { status: "error", message: "Worker not found.", values: input };
  }

  // The detail and edit pages both render this worker, so revalidating only
  // the dashboard leaves them serving pre-save values. Navigating back to the
  // edit form would then repopulate it from the stale cache, and saving again
  // would write those old values over the new ones.
  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/workers/${id}`);
  revalidatePath(`/dashboard/workers/${id}/edit`);

  return { status: "success", message: `Worker "${input.name}" saved.` };
}
