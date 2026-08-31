import "server-only";

import { type DbClient, prisma } from "@/lib/prisma";
import {
  type CreateRoutineInput,
  isRoutineFrequency,
  isRoutineKind,
  isRoutineStatus,
  type Routine,
  type RoutineInput,
  type RoutineKind,
} from "@/types";

export type RoutineRecord = Awaited<
  ReturnType<typeof prisma.routine.findFirstOrThrow>
>;

/**
 * Turns a stored row into the worker the rest of the application sees.
 *
 * Two things happen here. `status` and `frequency` are plain string columns,
 * so they are narrowed — the database will accept anything the application
 * does not. And every field is named rather than spread, which decides what a
 * row is allowed to carry outwards.
 *
 * **The naming is what keeps execution ownership off the wire.** `Routine`
 * reaches client components, so a spread would send `executionOwner` and
 * `executionLeaseUntil` to the browser the moment those columns existed —
 * internal execution state travelling with a worker that has no use for it.
 * Listing the fields makes exposure something a column opts into: a new one
 * stays server-side until somebody adds it here, and a field `Routine`
 * requires but this omits is a type error rather than an absence noticed later.
 */
export function toRoutine(record: RoutineRecord): Routine {
  return {
    id: record.id,
    userId: record.userId,
    name: record.name,
    description: record.description,
    prompt: record.prompt,
    // **The fallback direction is the one that does no external I/O.** A row
    // whose kind cannot be read becomes a `prompt` worker, which sends its
    // prompt to a model and reaches nothing else. Falling back the other way
    // would mean an unreadable value could start a worker fetching, which is
    // the one direction a default must never take.
    //
    // It is a display and dispatch default, not an authorisation check.
    // **Execution has to branch on the kind explicitly** and treat a `website`
    // worker with no source as a failure rather than quietly running its
    // prompt — a silent fall-through there would produce a confident answer
    // about a page nobody read.
    kind: isRoutineKind(record.kind) ? record.kind : "prompt",
    status: isRoutineStatus(record.status) ? record.status : "draft",
    frequency: isRoutineFrequency(record.frequency)
      ? record.frequency
      : "manual",
    runAtMinutes: record.runAtMinutes,
    runAtWeekday: record.runAtWeekday,
    runAtDay: record.runAtDay,
    nextRunAt: record.nextRunAt,
    emailNotificationsEnabled: record.emailNotificationsEnabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export async function listRoutines(userId: string): Promise<Routine[]> {
  const records = await prisma.routine.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  return records.map(toRoutine);
}

/** Returns null for both "missing" and "someone else's" — callers 404 on either. */
export async function getRoutine(
  id: string,
  userId: string,
): Promise<Routine | null> {
  const record = await prisma.routine.findFirst({ where: { id, userId } });
  return record ? toRoutine(record) : null;
}

/**
 * Hires a worker.
 *
 * **The only write that sets a kind.** `CreateRoutineInput` carries one and
 * `RoutineInput` does not, so what a worker is gets decided here and nowhere
 * else — `updateRoutine` below takes a `Partial<RoutineInput>` and therefore
 * has no shape that could carry a kind to change it to.
 *
 * The kind is written rather than left to the column's default. The default
 * exists so that rows created before watchers did read as prompt workers; a new
 * row should say what it is, and relying on the default would mean the answer
 * lived in the schema for some rows and in the code for others.
 *
 * **Takes a client so a caller can make this part of something larger.** A
 * website worker is a routine *and* a source, and half of that pair is not a
 * worker — see `createWebsiteSource`.
 */
export async function createRoutine(
  input: CreateRoutineInput,
  userId: string,
  client: DbClient = prisma,
): Promise<Routine> {
  const record = await client.routine.create({ data: { ...input, userId } });
  return toRoutine(record);
}

/**
 * A worker, and what it is — with "nothing we recognise" kept as an answer.
 *
 * **`getRoutine` cannot express this, deliberately.** `toRoutine` turns an
 * unreadable kind into `prompt` so that a list or a card can still render, and
 * that default is right for display: showing a worker is harmless, and every
 * screen needs *something*. It is wrong everywhere the kind decides what
 * happens next. A page that says "Prompt" about a row nobody can read has
 * stated a fact it does not have; a form that offers to save it would write
 * that guess in, converting a worker by accident.
 *
 * So this hands the caller both halves and lets it choose. `kind` is null when
 * the stored value is not one this version knows — and null is not `prompt`.
 */
export type RoutineWithStoredKind = {
  routine: Routine;
  kind: RoutineKind | null;
};

export async function getRoutineWithStoredKind(
  id: string,
  userId: string,
): Promise<RoutineWithStoredKind | null> {
  const record = await prisma.routine.findFirst({ where: { id, userId } });

  if (!record) {
    return null;
  }

  return {
    routine: toRoutine(record),
    kind: isRoutineKind(record.kind) ? record.kind : null,
  };
}

/**
 * The worker as something that is about to be changed.
 *
 * **A kind nothing recognises is treated as no worker at all** — the same
 * answer as somebody else's, and for a related reason: in both cases there is
 * nothing here this caller may safely change. Offering a form for a worker
 * nobody can describe would end in saving an answer that was never given.
 *
 * Returning null rather than throwing keeps the caller's shape: the edit page
 * and the edit action both already have to answer "no such worker".
 */
export async function getRoutineForEdit(
  id: string,
  userId: string,
): Promise<Routine | null> {
  const found = await getRoutineWithStoredKind(id, userId);

  if (!found) {
    return null;
  }

  if (found.kind === null) {
    // Worth a line, because it means a row exists that this deployment cannot
    // account for. The id only — nothing about the account or its contents.
    console.warn(
      `[worker] refusing to edit a worker of an unrecognised kind — id=${found.routine.id}`,
    );
    return null;
  }

  return found.routine;
}

/**
 * Changes a worker that already exists.
 *
 * **`Partial<RoutineInput>` is what makes a kind unchangeable.** The type holds
 * no kind, so there is no value this can be handed that would write one — the
 * decision made at creation stays made, and a worker cannot be converted into
 * something its other rows do not match.
 *
 * Takes a client so that a change which is not only a worker — a watched
 * address moving, which resets the baseline with it — can land as one.
 */
export async function updateRoutine(
  id: string,
  input: Partial<RoutineInput>,
  userId: string,
  client: DbClient = prisma,
): Promise<Routine | null> {
  const { count } = await client.routine.updateMany({
    where: { id, userId },
    data: input,
  });

  if (count === 0) {
    return null;
  }

  // Read back through the same client: inside a transaction, the module's own
  // would be looking at the database as it was before any of this.
  const record = await client.routine.findFirst({ where: { id, userId } });
  return record ? toRoutine(record) : null;
}

export async function deleteRoutine(
  id: string,
  userId: string,
): Promise<boolean> {
  const { count } = await prisma.routine.deleteMany({ where: { id, userId } });
  return count > 0;
}

/**
 * Takes a worker's pending slot, reporting whether this caller got it.
 *
 * The write lands only while `nextRunAt` still holds `expected` — the value the
 * caller read a moment ago. Two dispatchers reaching the same slot therefore
 * produce one `true` and one `false`: a single `UPDATE` is atomic, so by the
 * time the loser's runs, its `WHERE` no longer matches anything.
 *
 * **This is what stops a worker running twice**, and it needs no transaction to
 * do it. Wrapping the execution instead would mean holding one open across a
 * call to the AI provider, which is the case every guide on transactions tells
 * you to avoid.
 *
 * It works because the next slot is always later than the current one — the
 * schedule module never returns the value it was given. A frequency that could
 * land on the same instant would defeat the check silently.
 *
 * Deliberately not tenant-scoped: the dispatcher runs system-wide on behalf of
 * the platform, not a signed-in user.
 */
export async function claimRoutineSlot(
  id: string,
  expected: Date,
  nextRunAt: Date | null,
): Promise<boolean> {
  const { count } = await prisma.routine.updateMany({
    where: { id, nextRunAt: expected },
    data: { nextRunAt },
  });

  return count === 1;
}
