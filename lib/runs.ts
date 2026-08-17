import "server-only";

import { createAIProvider } from "@/lib/ai/factory";
import { providerErrorKind } from "@/lib/ai/provider";
import {
  acquireExecutionLease,
  ExecutionSuppressedError,
  releaseExecutionLease,
} from "@/lib/execution-lease";
import { prisma } from "@/lib/prisma";
import { promptVariables, renderPrompt } from "@/lib/prompt";
import {
  detectWebsiteChange,
  type WebsiteChangeState,
} from "@/lib/watcher/change";
import { decodeWebsiteContent } from "@/lib/watcher/decode";
import { isWatcherError } from "@/lib/watcher/errors";
import { fetchWatchedPage } from "@/lib/watcher/fetch";
import { normalizeWebsiteContent } from "@/lib/watcher/normalize";
import { getWebsiteSnapshot } from "@/lib/website-snapshots";
import { getWebsiteSource } from "@/lib/website-sources";
import {
  isRoutineKind,
  isRunStatus,
  type RunHistory,
  type RunHistoryDetail,
  type RunHistoryEntry,
} from "@/types";

const provider = createAIProvider();

type RunRecord = Awaited<ReturnType<typeof prisma.runHistory.findFirstOrThrow>>;

/**
 * Which write could not be made — the record of a success, or of a failure.
 *
 * It exists for the log, where the two read very differently: one says a run
 * that worked may not be written down, the other says a run that did not work
 * may not be either. Nothing branches on it.
 */
type PersistencePhase = "completed" | "failed";

/**
 * The run happened; writing down what it did is what failed.
 *
 * **Not an execution failure, and the whole point is not to record it as
 * one.** Until Sprint 39 the write that stores a success sat inside the same
 * `try` as the execution, so a database that would not take it sent the run
 * through the failure path — and a run that had worked was stored as `failed`,
 * carrying the database's complaint where the model's answer should have been.
 * The answer was gone and the two causes were indistinguishable afterwards.
 *
 * **What it does not claim is that nothing was written.** A driver that throws
 * after reaching the server may be reporting a lost response rather than a
 * rejected statement, and nothing here can tell which — so the row may be
 * `running`, or may be exactly what the write intended. Reading it back to
 * find out is recovery, and there is none.
 *
 * Deliberately unrelated to `ProviderErrorKind`: no model call went wrong.
 */
export class RunPersistenceError extends Error {
  readonly runId: string;
  readonly phase: PersistencePhase;

  constructor(
    phase: PersistencePhase,
    runId: string,
    options?: { cause?: unknown },
  ) {
    super(`Could not record the ${phase} state of run ${runId}.`, options);
    this.name = "RunPersistenceError";
    this.runId = runId;
    this.phase = phase;
  }
}

/** Whether a rejection means the outcome could not be written down. */
export function isRunPersistenceError(error: unknown): boolean {
  return error instanceof RunPersistenceError;
}

/**
 * The row says this worker is something execution does not know how to run.
 *
 * **Nothing happens, and that is the point.** `toRoutine` reads an unrecognised
 * kind as `prompt`, which is the right answer for a screen — it has to show
 * something, and a worker that reaches nothing outside the process is the safe
 * thing to show. It is the wrong answer for a run: executing a worker's prompt
 * because its kind could not be read would produce a confident model answer
 * about a page nobody fetched, recorded as a success.
 *
 * So the reading stays as it is and execution refuses instead. This is raised
 * before the lease, before any row, and before anything leaves the process.
 *
 * The same minimal shape as `ExecutionSuppressedError` and
 * `RunPersistenceError`: one class and one predicate, not a taxonomy.
 */
export class UnsupportedRoutineKindError extends Error {
  readonly routineId: string;
  /** What the column actually held. Kept off the message, which is read aloud. */
  readonly kind: string;

  constructor(routineId: string, kind: string) {
    super(`Worker ${routineId} has a kind execution does not recognise.`);
    this.name = "UnsupportedRoutineKindError";
    this.routineId = routineId;
    this.kind = kind;
  }
}

/** Whether a rejection means the worker's kind could not be acted on. */
export function isUnsupportedRoutineKind(error: unknown): boolean {
  return error instanceof UnsupportedRoutineKindError;
}

/**
 * Turns a stored row into the run the rest of the application sees.
 *
 * `status` is a plain string column, so it is narrowed here — the database
 * will accept anything the application does not. Every other field is named
 * rather than spread, for the same reason `toRoutine` names its own: a run
 * reaches client components, so what a column carries outwards should be
 * something it opts into rather than something it gets by default.
 */
function toRun(record: RunRecord): RunHistory {
  return {
    id: record.id,
    routineId: record.routineId,
    userId: record.userId,
    status: isRunStatus(record.status) ? record.status : "running",
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    output: record.output,
    errorMessage: record.errorMessage,
  };
}

export async function listRunHistory(
  userId: string,
): Promise<RunHistoryEntry[]> {
  const records = await prisma.runHistory.findMany({
    where: { userId },
    orderBy: { startedAt: "desc" },
    include: { routine: { select: { name: true } } },
  });

  return records.map(({ routine, ...record }) => ({
    ...toRun(record),
    routineName: routine.name,
  }));
}

/**
 * Every run of a single worker, newest first.
 *
 * Tenant-scoped like every other read, so it cannot report runs belonging to
 * someone else's worker.
 */
export async function listRunsForWorker(
  routineId: string,
  userId: string,
): Promise<RunHistory[]> {
  const records = await prisma.runHistory.findMany({
    where: { routineId, userId },
    orderBy: { startedAt: "desc" },
  });

  return records.map(toRun);
}

/** Returns null for both "missing" and "someone else's" — callers 404 on either. */
export async function getRun(
  id: string,
  userId: string,
): Promise<RunHistoryDetail | null> {
  const found = await prisma.runHistory.findFirst({
    where: { id, userId },
    include: { routine: { select: { name: true, prompt: true } } },
  });

  if (!found) {
    return null;
  }

  const { routine, ...record } = found;
  return {
    ...toRun(record),
    routineName: routine.name,
    routinePrompt: routine.prompt,
  };
}

/**
 * When execution last failed, anywhere on the platform, or null if it never has.
 *
 * **An observation, and deliberately a thin one.** A failed run is visible to
 * the person who owns the worker — the activity feed, the health summary and
 * the execution's own page all say so — and visible to nobody else. Nothing
 * reads run history across tenants, so an operator watching a Closed Beta has
 * no way to notice that executions have started failing. One timestamp on
 * every tick is the smallest thing that answers that.
 *
 * **It answers "when", not "how many" and not "whose".** A window would need a
 * length, and there is no honest number to derive one from — the cron interval
 * lives in the platform's configuration rather than here. The most recent
 * failure needs no window: it cannot miss one, and it repeats on every tick
 * until something newer replaces it, which is the right direction for
 * something that only ever gets read by accident.
 *
 * **Deliberately not scoped to a tenant.** It is asked on behalf of the
 * platform, the same standing `getDueWorkers` has, and the same reason: no
 * signed-in user is involved. What comes back is a timestamp and nothing else
 * — no prompt, no output, no message, no id, nobody's email.
 *
 * **It reads `RunHistory` and nothing else**, so it survives execution moving
 * off the request: whatever runs a worker, a failure it recorded is a row here.
 * Reading what the dispatcher happened to return would not have survived it.
 *
 * `finishedAt` rather than `startedAt`, because the failure happened when it
 * was recorded, not when the run began. Requiring it to be set also keeps the
 * ordering well defined — a nullable column sorted descending would otherwise
 * put the nulls first.
 */
export async function latestExecutionFailureAt(): Promise<Date | null> {
  const latest = await prisma.runHistory.findFirst({
    where: { status: "failed", finishedAt: { not: null } },
    orderBy: { finishedAt: "desc" },
    select: { finishedAt: true },
  });

  return latest?.finishedAt ?? null;
}

/**
 * Executes a routine.
 *
 * **How long this takes is the provider's business, not this function's.**
 * `ClaudeProvider` takes as long as the model does — seconds, occasionally
 * minutes, and at most the ten it is given. The stand-in returns immediately,
 * and a run that finishes in no measurable time is the honest signal that no
 * model was called.
 *
 * The run inherits the routine's owner, so both the manual and the dispatched
 * path record it without the caller having to pass a user through.
 *
 * **A failing provider is a result, not an exception.** It comes back as a
 * `failed` record, which is what makes the failure countable in the health
 * summary instead of vanishing up the call stack. Callers depend on this: the
 * manual run action reads `status` to choose its message, and the dispatcher
 * advances the schedule without having to ask.
 *
 * **A worker that is already running is the one case with no record at all.**
 * Both paths into execution arrive here — a cron tick that won a slot, and a
 * button someone pressed — and neither knows about the other, so this is the
 * only place that can tell they have met. Taking the lease first means a
 * second arrival stops before anything exists to describe it: no row, no
 * provider call, and an `ExecutionSuppressedError` for whoever asked. That is
 * deliberately not a `failed` run; nothing went wrong, and a run that never
 * started has no outcome to record.
 *
 * **The lease is execution ownership, and the claim is not.** A cron tick has
 * already spent the slot by the time it gets here (`claimRoutineSlot`), and
 * that stays spent — the slot was taken, whatever happens next. Nothing below
 * reads or writes `nextRunAt`.
 *
 * **It is not an unconditional guarantee of one run at a time.** The lease
 * lasts a fixed span and nothing renews it, so a run that outlives its own
 * lease can overlap with the one that takes over. What holds regardless is
 * that the older run cannot release the newer one's claim.
 */
export async function runRoutine(routineId: string): Promise<RunHistory> {
  // Read before taking the lease, so a worker that has been deleted still
  // reports itself as missing. Acquiring first would match no row and be
  // indistinguishable from contention — the dispatcher counts a vanished
  // worker as a failed hand-off, and that should not quietly become silence.
  //
  // **The kind comes from here rather than from `toRoutine`.** What is wanted
  // is the value the column holds, not the value a reader would be shown: the
  // conversion answers `prompt` for anything it cannot read, and running on
  // that answer is the one thing this must not do.
  const routine = await prisma.routine.findUniqueOrThrow({
    where: { id: routineId },
    select: { userId: true, prompt: true, kind: true },
  });

  // **Before the lease, before the row, before anything leaves the process.**
  // A worker whose kind cannot be read has no correct execution, so it gets
  // none — no lease taken, no run recorded, no request made. Refusing later
  // would mean deciding what to write down about a run that should not have
  // been started.
  if (!isRoutineKind(routine.kind)) {
    throw new UnsupportedRoutineKindError(routineId, routine.kind);
  }

  const lease = await acquireExecutionLease(routineId);
  if (lease === null) {
    throw new ExecutionSuppressedError(routineId);
  }

  try {
    // Both kinds share the lease, the run row, and the release below. What
    // differs is only what happens between them.
    return routine.kind === "website"
      ? await executeWebsite(routineId, routine.userId)
      : await executePrompt(routineId, routine.userId, routine.prompt);
  } finally {
    // Every path out of the execution above comes through here — the result,
    // the failure, and the writes that record either. **The release cannot
    // throw**, which is what stops a failed cleanup from replacing the outcome
    // it was cleaning up after. A lease left behind lapses on its own.
    await releaseExecutionLease(routineId, lease.token);
  }
}

/**
 * A prompt worker's execution, once the right to run it is held.
 *
 * Split out so the lease has a single, obvious span: everything in here
 * happens while it is held, and the caller's `finally` gives it back.
 *
 * **Unchanged by the arrival of website workers.** They take a different
 * branch above rather than a flag inside this one, so what a prompt worker
 * does is exactly what it did.
 */
async function executePrompt(
  routineId: string,
  userId: string,
  routinePrompt: string,
): Promise<RunHistory> {
  // **Outside everything below**, because a run that has no row has not
  // started. The dispatcher counts a worker it could not start as `failed`,
  // and this is one of the ways that happens — it is not the same event as a
  // run that ran and could not be written down.
  const run = await prisma.runHistory.create({
    data: { routineId, userId, status: "running" },
  });

  // **Only the execution is inside this `try`.** The write that records a
  // success used to be in here too, which meant a database that refused it
  // sent a working run down the failure path. What can fail here is the
  // prompt and the model, and both of those are results a run can have.
  let output: string;
  try {
    const prompt = renderPrompt(routinePrompt, promptVariables());
    output = await provider.execute(prompt);
  } catch (error) {
    // **The kind is logged, not stored**, and it is logged only here — this is
    // the one place the failure is a provider's. Naming a column for it means
    // deciding what `failed` means, and that is not settled.
    console.error(
      "[worker] run failed —",
      providerErrorKind(error),
      "—",
      error,
    );

    return recordFailure(run.id, providerFailureMessage(error));
  }

  return recordSuccess(run.id, output);
}

/**
 * What a website worker's run says when nothing went wrong.
 *
 * **Written by AutoOps, not by a model**, which is the whole difference between
 * these and a prompt worker's output: no model is called on either of these
 * paths, so the row has to say something for itself. They are fixed sentences
 * rather than composed ones so that two runs of the same worker in the same
 * state are identical.
 */
const BASELINE_NOT_ESTABLISHED = "Website baseline is not established yet.";
const CONTENT_UNCHANGED = "Website content has not changed.";

/**
 * What a change currently amounts to.
 *
 * **A change is detected and then not acted on**, because the part that acts on
 * it — reading what changed, asking a model to describe it, moving the baseline
 * — is not connected yet. Recording that as a completed run would say the work
 * was done.
 *
 * **The baseline does not move**, so the same change is found again next time.
 * That is what makes this safe to ship ahead of the rest: nothing is consumed.
 */
const CHANGE_PROCESSING_UNAVAILABLE =
  "Website change processing is not available yet.";

/** A website worker with nowhere to look. Configuration, not a failure to fetch. */
const NO_WEBSITE_CONFIGURED = "This worker has no website address to watch.";

/**
 * A website worker's execution, once the right to run it is held.
 *
 * ```
 * source → fetch → decode → normalize → baseline → compare
 * ```
 *
 * **Every step is somebody else's module.** Nothing here parses HTML, resolves
 * a charset, or decides what counts as a change; doing any of that a second
 * time in here is how two answers to the same question start disagreeing.
 *
 * **Nothing here writes a snapshot, and nothing calls a model.** Both belong to
 * the same later step: moving a baseline is only safe once the work the change
 * triggered has succeeded, and there is no such work yet. Until then every
 * outcome leaves the stored state exactly as it found it.
 */
async function executeWebsite(
  routineId: string,
  userId: string,
): Promise<RunHistory> {
  // A row first, for the same reason a prompt worker gets one: an attempt that
  // reached execution is an attempt, however it turns out. One run, one row.
  const run = await prisma.runHistory.create({
    data: { routineId, userId, status: "running" },
  });

  let change: WebsiteChangeState;

  try {
    // Scoped to the owner, through the routine — a source has no owner column
    // of its own, and this is the only thing that says who it belongs to.
    const source = await getWebsiteSource(routineId, userId);
    if (source === null) {
      // **Not a fallback to running the prompt.** A website worker with no
      // address configured has nothing to do, and doing something else instead
      // would answer a question nobody asked.
      console.error("[worker] website run has no source configured", routineId);
      return recordFailure(run.id, NO_WEBSITE_CONFIGURED);
    }

    change = await inspectWebsite(source.id, source.url);
  } catch (error) {
    // **The kind is logged, not stored**, the same standing the provider's kind
    // has. Nothing about the page itself is logged — not the body, not the
    // text, not the address.
    console.error(
      "[worker] website run failed —",
      watcherFailureKind(error),
      "—",
      error,
    );

    return recordFailure(run.id, watcherFailureMessage(error));
  }

  if (change.state === "changed") {
    console.warn(
      "[worker] website changed, but change processing is not connected",
      routineId,
    );

    return recordFailure(run.id, CHANGE_PROCESSING_UNAVAILABLE);
  }

  return recordSuccess(
    run.id,
    change.state === "initial" ? BASELINE_NOT_ESTABLISHED : CONTENT_UNCHANGED,
  );
}

/**
 * Reads the page and says how it compares with the baseline held for it.
 *
 * **Read-only, all the way through.** The snapshot is fetched to compare
 * against and nothing is written back, so this can be called twice and leave
 * the same state behind both times.
 */
async function inspectWebsite(
  websiteSourceId: string,
  url: string,
): Promise<WebsiteChangeState> {
  // Every address check, redirect check, size limit and timeout lives in here.
  const page = await fetchWatchedPage(url);
  // Bytes and the header that says what they mean — the fetch decodes neither.
  const decoded = decodeWebsiteContent(page.body, page.contentTypeHeader);
  const current = normalizeWebsiteContent(decoded.content, decoded.mediaType);
  const baseline = await getWebsiteSnapshot(websiteSourceId);

  return detectWebsiteChange(baseline, current);
}

/** The provider's own wording, which is what a failed run has always stored. */
function providerFailureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Execution failed.";
}

/** The kind of a watcher failure, for the log. `unknown` for anything else. */
function watcherFailureKind(error: unknown): string {
  return isWatcherError(error) ? error.kind : "unknown";
}

/**
 * What a failed website run records.
 *
 * **Only a watcher failure's own wording is stored.** Those sentences are
 * written to be read by the person whose worker it is and carry none of what
 * must not travel — no resolved address, no response body, no page text. Any
 * other failure is something unexpected, and an unexpected error's message is
 * not written for anybody; it goes to the log and the row gets a fixed
 * sentence instead.
 */
function watcherFailureMessage(error: unknown): string {
  return isWatcherError(error) ? error.message : "Execution failed.";
}

/**
 * Writes down that the run worked.
 *
 * A refusal from the database here says nothing about the run, which is why it
 * leaves rather than turning into one. **Nothing writes a `failed` row after
 * this point** — doing so would replace what happened with what could not be
 * saved, and lose the answer on the way.
 */
async function recordSuccess(
  runId: string,
  output: string,
): Promise<RunHistory> {
  try {
    const finished = await prisma.runHistory.update({
      where: { id: runId },
      data: {
        status: "completed",
        finishedAt: new Date(),
        output,
        errorMessage: null,
      },
    });

    return toRun(finished);
  } catch (error) {
    console.error(
      "[worker] could not record a completed run — the run itself succeeded",
      runId,
      error,
    );

    throw new RunPersistenceError("completed", runId, { cause: error });
  }
}

/**
 * Writes down that the run failed, and why.
 *
 * **The reason goes in its own column and `output` stays empty.** The caller
 * decides what the sentence is, because what may safely be stored differs by
 * where the failure came from — a provider's message travels as it is, and an
 * unexpected error's does not.
 *
 * When even this cannot be written, the failure leaves as a persistence error
 * rather than as a `failed` run: there is no row saying so, and returning one
 * would be describing a record that does not exist. **Both halves are in the
 * log** — the execution failure was written above before this was attempted.
 */
async function recordFailure(
  runId: string,
  errorMessage: string,
): Promise<RunHistory> {
  try {
    const failed = await prisma.runHistory.update({
      where: { id: runId },
      data: {
        status: "failed",
        finishedAt: new Date(),
        output: "",
        errorMessage,
      },
    });

    return toRun(failed);
  } catch (error) {
    console.error(
      "[worker] could not record a failed run — the failure above is unrecorded",
      runId,
      error,
    );

    throw new RunPersistenceError("failed", runId, { cause: error });
  }
}
