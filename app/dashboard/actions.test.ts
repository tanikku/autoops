import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionSuppressedError } from "@/lib/execution-lease";
import { RunPersistenceError } from "@/lib/runs";

/**
 * What the button says back, and what it leaves alone.
 *
 * The one distinction worth fixing here is between a worker that is busy and
 * a run that went wrong: both come back as `error`, because a toast has two
 * colours, but the sentences lead somewhere different — one says wait, the
 * other says something is broken.
 *
 * The rest is about restraint. A hand-started run competes for execution, not
 * for a slot, so nothing in this path may touch the schedule.
 */

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  getUserLanguage: vi.fn(),
  getRoutine: vi.fn(),
  deleteRoutine: vi.fn(),
  enqueueRoutine: vi.fn(),
  acquireManualRunSlot: vi.fn(),
  releaseManualRunSlot: vi.fn(),
  consumeManualRunQuota: vi.fn(),
  claimRoutineSlot: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/session", () => ({ requireUserId: mocks.requireUserId }));
// **Mocked rather than left real.** These messages are read from the account
// row now, and a unit test that reached for one would be asking a database
// that CI does not have.
vi.mock("@/lib/users", () => ({ getUserLanguage: mocks.getUserLanguage }));
vi.mock("@/lib/queue", () => ({ enqueueRoutine: mocks.enqueueRoutine }));
// The account-level guard is a boundary of its own — what it does with the row
// it keeps is fixed in `lib/manual-run-slot.test.ts`. What these need from it is
// the answer, when it was asked for, and whether it was given back.
vi.mock("@/lib/manual-run-slot", () => ({
  acquireManualRunSlot: mocks.acquireManualRunSlot,
  releaseManualRunSlot: mocks.releaseManualRunSlot,
}));
// The allowance is a boundary of its own — what it does with the row it keeps
// is fixed in `lib/rate-limit.test.ts`. What these need from it is the answer,
// when it was asked for, and that it is asked exactly once.
vi.mock("@/lib/rate-limit", () => ({
  consumeManualRunQuota: mocks.consumeManualRunQuota,
}));
vi.mock("@/lib/routines", () => ({
  getRoutine: mocks.getRoutine,
  deleteRoutine: mocks.deleteRoutine,
  claimRoutineSlot: mocks.claimRoutineSlot,
}));

const { deleteWorkerAction, runRoutineAction } = await import(
  "@/app/dashboard/actions"
);

/** `requireUserId` leaves by throwing when there is no session, as `redirect` does. */
class RedirectSignal extends Error {}

const NOW = new Date("2026-08-28T12:00:00.000Z");

function form(routineId: string) {
  const data = new FormData();
  data.set("routineId", routineId);
  return data;
}

beforeEach(() => {
  mocks.requireUserId.mockReset().mockResolvedValue("user-1");
  // English by default, so the assertions below stay about what the button
  // reports rather than about which words it reports it in.
  mocks.getUserLanguage.mockReset().mockResolvedValue("en");
  mocks.getRoutine.mockReset().mockResolvedValue({
    id: "worker-1",
    name: "Daily digest",
  });
  mocks.deleteRoutine.mockReset().mockResolvedValue(true);
  mocks.enqueueRoutine.mockReset().mockResolvedValue({ status: "completed" });
  mocks.acquireManualRunSlot
    .mockReset()
    .mockResolvedValue({ slotNumber: 0, token: "slot-token", expiresAt: NOW });
  mocks.releaseManualRunSlot.mockReset().mockResolvedValue("released");
  mocks.consumeManualRunQuota.mockReset().mockResolvedValue(true);
  mocks.claimRoutineSlot.mockReset();
  mocks.revalidatePath.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("runRoutineAction", () => {
  it("reports a successful run", async () => {
    const result = await runRoutineAction(null, form("worker-1"));

    expect(result).toEqual({
      status: "success",
      message: '"Daily digest" ran successfully.',
    });
  });

  it("reports a run that failed", async () => {
    mocks.enqueueRoutine.mockResolvedValue({ status: "failed" });

    expect(await runRoutineAction(null, form("worker-1"))).toEqual({
      status: "error",
      message: '"Daily digest" failed to run.',
    });
  });

  /**
   * Already running is not a failure, and the wording has to say which it is:
   * "failed to run" would send someone looking for a fault there isn't.
   */
  it("says the worker is already running rather than that it failed", async () => {
    mocks.enqueueRoutine.mockRejectedValue(
      new ExecutionSuppressedError("worker-1"),
    );

    expect(await runRoutineAction(null, form("worker-1"))).toEqual({
      status: "error",
      message: '"Daily digest" is already running.',
    });
  });

  /**
   * The run reached a provider, so "failed to run" would be wrong — and so
   * would claiming the result was lost, since a write that throws may have
   * landed anyway. The sentence says what is known and stops there.
   */
  it("says the outcome could not be recorded rather than that the run failed", async () => {
    mocks.enqueueRoutine.mockRejectedValue(
      new RunPersistenceError("completed", "run-1"),
    );

    expect(await runRoutineAction(null, form("worker-1"))).toEqual({
      status: "error",
      message: '"Daily digest" started, but its outcome could not be recorded.',
    });
  });

  it("says the same when a failure was the thing that could not be recorded", async () => {
    mocks.enqueueRoutine.mockRejectedValue(
      new RunPersistenceError("failed", "run-1"),
    );

    expect(
      (await runRoutineAction(null, form("worker-1")))?.message,
    ).toContain("could not be recorded");
  });

  it("still reports an ordinary failure as one", async () => {
    mocks.enqueueRoutine.mockRejectedValue(new Error("boom"));

    expect(await runRoutineAction(null, form("worker-1"))).toEqual({
      status: "error",
      message: '"Daily digest" failed to run.',
    });
  });

  /**
   * A hand-started run takes execution ownership, never a scheduled slot. It
   * must leave `nextRunAt` exactly where the schedule put it.
   */
  it("never claims a slot, whatever the outcome", async () => {
    await runRoutineAction(null, form("worker-1"));

    mocks.enqueueRoutine.mockRejectedValue(
      new ExecutionSuppressedError("worker-1"),
    );
    await runRoutineAction(null, form("worker-1"));

    expect(mocks.claimRoutineSlot).not.toHaveBeenCalled();
  });

  it("rejects a worker belonging to someone else without running anything", async () => {
    mocks.getRoutine.mockResolvedValue(null);

    expect(await runRoutineAction(null, form("worker-1"))).toEqual({
      status: "error",
      message: "Worker not found.",
    });
    expect(mocks.enqueueRoutine).not.toHaveBeenCalled();
  });
});

/**
 * Deleting, and the three answers it has to keep apart.
 *
 * A worker that was not this account's and a worker that never existed are the
 * same answer on purpose. A database that refused the write is not: nothing was
 * deleted there either, but something is wrong, and the difference belongs in
 * the log rather than in what the person who pressed the button is told.
 */
describe("deleteWorkerAction", () => {
  it("reports a worker that was deleted", async () => {
    const result = await deleteWorkerAction("worker-1", null);

    expect(result).toEqual({
      status: "success",
      message: "Worker deleted.",
    });
  });

  it("deletes only within the signed-in account", async () => {
    await deleteWorkerAction("worker-1", null);

    expect(mocks.deleteRoutine).toHaveBeenCalledWith("worker-1", "user-1");
  });

  it("revalidates the dashboard once the row is gone", async () => {
    await deleteWorkerAction("worker-1", null);

    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  /**
   * The query matched on the id *and* the owner, so a worker belonging to
   * someone else is indistinguishable from one that is not there.
   */
  it("says not found when nothing matched, and revalidates nothing", async () => {
    mocks.deleteRoutine.mockResolvedValue(false);

    expect(await deleteWorkerAction("worker-1", null)).toEqual({
      status: "error",
      message: "Worker not found.",
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  /**
   * The one this action used to get wrong: the write escaped, and it escaped
   * onto a page the caller had already navigated away from.
   */
  it("fails safely when the delete itself throws", async () => {
    mocks.deleteRoutine.mockRejectedValue(new Error("connection terminated"));

    expect(await deleteWorkerAction("worker-1", null)).toEqual({
      status: "error",
      message: "Could not delete the worker.",
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("keeps the database's own wording out of what it returns", async () => {
    mocks.deleteRoutine.mockRejectedValue(
      new Error('relation "Routine" does not exist'),
    );

    const result = await deleteWorkerAction("worker-1", null);

    expect(result?.message).not.toContain("relation");
  });

  /** A refused write and a row that was not there are not the same answer. */
  it("distinguishes a refused write from a worker that was not found", async () => {
    mocks.deleteRoutine.mockResolvedValue(false);
    const notFound = await deleteWorkerAction("worker-1", null);

    mocks.deleteRoutine.mockRejectedValue(new Error("boom"));
    const refused = await deleteWorkerAction("worker-1", null);

    expect(notFound?.message).not.toBe(refused?.message);
  });

  it("sends a signed-out visitor back without touching anything", async () => {
    mocks.requireUserId.mockRejectedValue(new RedirectSignal());

    await expect(deleteWorkerAction("worker-1", null)).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(mocks.deleteRoutine).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

/**
 * The same answers, in the account's language.
 *
 * **The worker's name is the owner's and is placed into the sentence**, not
 * translated and not glued to one end of it — the two languages do not put it
 * in the same spot.
 */
/**
 * One hand-started run per account, whatever worker it belongs to.
 *
 * **The button's `pending` state is not this.** It disables one form in one
 * browser tab; the guard is asked for on the server, on every invocation of the
 * action, so a second tab or a request made by hand goes through the same door.
 *
 * **It is asked after ownership and before the queue**, which is where the
 * manual path stops being its own and becomes the one scheduled execution
 * shares. Everything below that is bounded by the tick's own limits instead.
 */
describe("runRoutineAction — one run per account", () => {
  it("asks for the slot after ownership and before anything runs", async () => {
    await runRoutineAction(null, form("worker-1"));

    expect(mocks.acquireManualRunSlot).toHaveBeenCalledWith("user-1");
    expect(mocks.getRoutine.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.acquireManualRunSlot.mock.invocationCallOrder[0],
    );
    expect(mocks.acquireManualRunSlot.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.enqueueRoutine.mock.invocationCallOrder[0],
    );
  });

  it("starts nothing when the account already has a run going", async () => {
    mocks.acquireManualRunSlot.mockResolvedValue(null);

    expect(await runRoutineAction(null, form("worker-1"))).toEqual({
      status: "error",
      message:
        "Another run of yours is still in progress. Wait for it to finish.",
    });
    expect(mocks.enqueueRoutine).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("logs nothing for a refusal, because nothing went wrong", async () => {
    mocks.acquireManualRunSlot.mockResolvedValue(null);
    vi.mocked(console.error).mockClear();

    await runRoutineAction(null, form("worker-1"));

    expect(console.error).not.toHaveBeenCalled();
    // Nothing was taken, so there is nothing to give back.
    expect(mocks.releaseManualRunSlot).not.toHaveBeenCalled();
  });

  it("says so in Japanese for an account that reads Japanese", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");
    mocks.acquireManualRunSlot.mockResolvedValue(null);

    expect(await runRoutineAction(null, form("worker-1"))).toEqual({
      status: "error",
      message: "別の実行がまだ進行中です。完了してからもう一度お試しください。",
    });
  });

  it("never asks for a slot for a worker that is not the account's", async () => {
    mocks.getRoutine.mockResolvedValue(null);

    await runRoutineAction(null, form("worker-1"));

    expect(mocks.acquireManualRunSlot).not.toHaveBeenCalled();
  });

  it("never asks for one when there is no session", async () => {
    mocks.requireUserId.mockImplementation(() => {
      throw new RedirectSignal("/");
    });

    await expect(
      runRoutineAction(null, form("worker-1")),
    ).rejects.toBeInstanceOf(RedirectSignal);
    expect(mocks.acquireManualRunSlot).not.toHaveBeenCalled();
  });
});

/**
 * Giving the slot back, whichever way the run ended.
 *
 * **A crash is the one case none of these covers**, and nothing here pretends
 * otherwise: a process that dies never reaches a `finally`. What recovers the
 * slot then is its expiry, which is why it has one.
 */
describe("runRoutineAction — giving the slot back", () => {
  function expectReleased() {
    expect(mocks.releaseManualRunSlot).toHaveBeenCalledWith(
      "user-1",
      0,
      "slot-token",
    );
  }

  it("releases it after a run that finished", async () => {
    await runRoutineAction(null, form("worker-1"));

    expectReleased();
  });

  it("releases it after a run that failed", async () => {
    mocks.enqueueRoutine.mockResolvedValue({ status: "failed" });

    await runRoutineAction(null, form("worker-1"));

    expectReleased();
  });

  it("releases it after execution threw", async () => {
    mocks.enqueueRoutine.mockRejectedValue(new Error("boom"));

    await runRoutineAction(null, form("worker-1"));

    expectReleased();
  });

  it("releases it after something that was not an Error was thrown", async () => {
    mocks.enqueueRoutine.mockRejectedValue("not an error");

    await runRoutineAction(null, form("worker-1"));

    expectReleased();
  });

  it("releases it after the outcome could not be recorded", async () => {
    mocks.enqueueRoutine.mockRejectedValue(
      new RunPersistenceError("completed", "run-1"),
    );

    await runRoutineAction(null, form("worker-1"));

    expectReleased();
  });

  /**
   * **The account's slot and the worker's lease are different questions**, and
   * this is where they meet: the account was free, the worker was not. The
   * answer somebody gets is the one they always got, and the slot taken on the
   * way in does not stay taken.
   */
  it("releases it when the worker turned out to be busy, keeping the old answer", async () => {
    mocks.enqueueRoutine.mockRejectedValue(
      new ExecutionSuppressedError("worker-1"),
    );

    expect(await runRoutineAction(null, form("worker-1"))).toEqual({
      status: "error",
      message: '"Daily digest" is already running.',
    });
    expectReleased();
  });
});

/**
 * A guard that cannot be read is not a guard that said yes.
 */
describe("runRoutineAction — a guard that will not answer", () => {
  function driverFailure() {
    return new Error('connection terminated: relation "ManualRunSlot"');
  }

  it("starts nothing and says so without naming the database", async () => {
    mocks.acquireManualRunSlot.mockRejectedValue(driverFailure());

    const result = await runRoutineAction(null, form("worker-1"));

    expect(result).toEqual({
      status: "error",
      message: '"Daily digest" could not be started. Try again in a moment.',
    });
    expect(mocks.enqueueRoutine).not.toHaveBeenCalled();
    expect(mocks.releaseManualRunSlot).not.toHaveBeenCalled();
  });

  it("keeps the driver's own words out of what comes back", async () => {
    mocks.acquireManualRunSlot.mockRejectedValue(driverFailure());
    vi.mocked(console.error).mockClear();

    const result = await runRoutineAction(null, form("worker-1"));
    const message = (result as { message: string }).message;

    expect(message).not.toContain("ManualRunSlot");
    expect(message).not.toContain("connection terminated");
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error).mock.calls[0][0]).toBe(
      "[worker] manual run guard could not be read",
    );
  });

  it("says it could not be started in Japanese, rather than that it failed", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");
    mocks.acquireManualRunSlot.mockRejectedValue(driverFailure());

    expect(await runRoutineAction(null, form("worker-1"))).toEqual({
      status: "error",
      message:
        "「Daily digest」を開始できませんでした。しばらくしてからもう一度お試しください。",
    });
  });
});

/**
 * How many runs an account may start by hand in an hour.
 *
 * **A different question from the slot**, and the two are answered in that
 * order for a reason: the slot says whether a run of theirs is happening right
 * now, and this says whether they have started too many lately. A second press
 * while the first is still going is refused by the slot and costs nothing —
 * only a run that is actually about to start spends one.
 *
 * **Nothing gives it back.** What is bounded is the operation the account asked
 * for: a website worker that finds nothing changed asks no model and still
 * spends one, because it still fetched somebody else's page.
 */
describe("runRoutineAction — how many runs an hour", () => {
  it("starts the run when the account has room", async () => {
    await runRoutineAction(null, form("worker-1"));

    expect(mocks.consumeManualRunQuota).toHaveBeenCalledTimes(1);
    expect(mocks.consumeManualRunQuota).toHaveBeenCalledWith("user-1");
    expect(mocks.enqueueRoutine).toHaveBeenCalledTimes(1);
  });

  it("asks for the allowance after the slot and before anything runs", async () => {
    await runRoutineAction(null, form("worker-1"));

    expect(mocks.acquireManualRunSlot.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.consumeManualRunQuota.mock.invocationCallOrder[0],
    );
    expect(mocks.consumeManualRunQuota.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.enqueueRoutine.mock.invocationCallOrder[0],
    );
  });

  it("starts nothing once the allowance is spent", async () => {
    mocks.consumeManualRunQuota.mockResolvedValue(false);

    expect(await runRoutineAction(null, form("worker-1"))).toEqual({
      status: "error",
      message: "Manual run limit reached. Try again later.",
    });
    expect(mocks.enqueueRoutine).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("logs nothing for a refusal, because nothing went wrong", async () => {
    mocks.consumeManualRunQuota.mockResolvedValue(false);
    vi.mocked(console.error).mockClear();

    await runRoutineAction(null, form("worker-1"));

    expect(console.error).not.toHaveBeenCalled();
  });

  /**
   * **The slot goes back even though nothing ran.** A refusal that left it
   * held would cost the account fifteen minutes for pressing a button once —
   * which is why the allowance is asked for inside the `try` the release
   * belongs to rather than before it.
   */
  it("gives the slot back when the allowance refuses", async () => {
    mocks.consumeManualRunQuota.mockResolvedValue(false);

    await runRoutineAction(null, form("worker-1"));

    expect(mocks.releaseManualRunSlot).toHaveBeenCalledWith(
      "user-1",
      0,
      "slot-token",
    );
  });

  it("says so in Japanese for an account that reads Japanese", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");
    mocks.consumeManualRunQuota.mockResolvedValue(false);

    expect(await runRoutineAction(null, form("worker-1"))).toEqual({
      status: "error",
      message:
        "手動実行の利用上限に達しました。しばらくしてからもう一度お試しください。",
    });
  });

  it.each([["draft"], ["paused"], ["active"]])(
    "counts a %s worker the same way",
    async (status) => {
      mocks.getRoutine.mockResolvedValue({
        id: "worker-1",
        name: "Daily digest",
        status,
      });

      await runRoutineAction(null, form("worker-1"));

      expect(mocks.consumeManualRunQuota).toHaveBeenCalledTimes(1);
      expect(mocks.enqueueRoutine).toHaveBeenCalledTimes(1);
    },
  );

  it("spends exactly one on a run that finished", async () => {
    await runRoutineAction(null, form("worker-1"));

    expect(mocks.consumeManualRunQuota).toHaveBeenCalledTimes(1);
  });

  it("gives nothing back when the run failed", async () => {
    mocks.enqueueRoutine.mockResolvedValue({ status: "failed" });

    await runRoutineAction(null, form("worker-1"));

    expect(mocks.consumeManualRunQuota).toHaveBeenCalledTimes(1);
  });

  it("gives nothing back when execution threw", async () => {
    mocks.enqueueRoutine.mockRejectedValue(new Error("boom"));

    await runRoutineAction(null, form("worker-1"));

    expect(mocks.consumeManualRunQuota).toHaveBeenCalledTimes(1);
    expect(mocks.releaseManualRunSlot).toHaveBeenCalled();
  });

  it("gives nothing back when the outcome could not be recorded", async () => {
    mocks.enqueueRoutine.mockRejectedValue(
      new RunPersistenceError("completed", "run-1"),
    );

    await runRoutineAction(null, form("worker-1"));

    expect(mocks.consumeManualRunQuota).toHaveBeenCalledTimes(1);
  });

  it("gives nothing back when the worker turned out to be busy", async () => {
    mocks.enqueueRoutine.mockRejectedValue(
      new ExecutionSuppressedError("worker-1"),
    );

    expect(await runRoutineAction(null, form("worker-1"))).toEqual({
      status: "error",
      message: '"Daily digest" is already running.',
    });
    expect(mocks.consumeManualRunQuota).toHaveBeenCalledTimes(1);
  });
});

/**
 * Where the allowance is *not* asked about.
 *
 * **Everything that answers before a run could start.** A press that was never
 * going to run anything must not cost the account one of its twenty — most of
 * all a second press while the first run is still going, which is the ordinary
 * way somebody meets the slot.
 */
describe("runRoutineAction — what costs nothing", () => {
  it("asks nothing when another run of theirs is in progress", async () => {
    mocks.acquireManualRunSlot.mockResolvedValue(null);

    expect(await runRoutineAction(null, form("worker-1"))).toEqual({
      status: "error",
      message:
        "Another run of yours is still in progress. Wait for it to finish.",
    });
    expect(mocks.consumeManualRunQuota).not.toHaveBeenCalled();
  });

  it("asks nothing when the slot itself could not be read", async () => {
    mocks.acquireManualRunSlot.mockRejectedValue(new Error("connection lost"));

    await runRoutineAction(null, form("worker-1"));

    expect(mocks.consumeManualRunQuota).not.toHaveBeenCalled();
  });

  it("asks nothing for a form that named no worker", async () => {
    await runRoutineAction(null, form(""));

    expect(mocks.consumeManualRunQuota).not.toHaveBeenCalled();
  });

  it("asks nothing when there is no session", async () => {
    mocks.requireUserId.mockImplementation(() => {
      throw new RedirectSignal("/");
    });

    await expect(
      runRoutineAction(null, form("worker-1")),
    ).rejects.toBeInstanceOf(RedirectSignal);
    expect(mocks.consumeManualRunQuota).not.toHaveBeenCalled();
  });

  it("asks nothing for a worker that is not the account's", async () => {
    mocks.getRoutine.mockResolvedValue(null);

    await runRoutineAction(null, form("worker-1"));

    expect(mocks.consumeManualRunQuota).not.toHaveBeenCalled();
  });
});

/**
 * An allowance that cannot be read is not an allowance that said yes.
 */
describe("runRoutineAction — an allowance that will not answer", () => {
  function driverFailure() {
    return new Error('connection terminated: relation "RateLimitBucket"');
  }

  it("starts nothing and says so without naming the database", async () => {
    mocks.consumeManualRunQuota.mockRejectedValue(driverFailure());

    const result = await runRoutineAction(null, form("worker-1"));

    expect(result).toEqual({
      status: "error",
      message: '"Daily digest" could not be started. Try again in a moment.',
    });
    expect(mocks.enqueueRoutine).not.toHaveBeenCalled();
  });

  it("keeps the driver's own words out of what comes back, and logs them", async () => {
    mocks.consumeManualRunQuota.mockRejectedValue(driverFailure());
    vi.mocked(console.error).mockClear();

    const result = await runRoutineAction(null, form("worker-1"));
    const message = (result as { message: string }).message;

    expect(message).not.toContain("RateLimitBucket");
    expect(message).not.toContain("connection terminated");
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error).mock.calls[0][0]).toBe(
      "[worker] manual run rate limit could not be read",
    );
  });

  it("gives the slot back", async () => {
    mocks.consumeManualRunQuota.mockRejectedValue(driverFailure());

    await runRoutineAction(null, form("worker-1"));

    expect(mocks.releaseManualRunSlot).toHaveBeenCalledWith(
      "user-1",
      0,
      "slot-token",
    );
  });
});

describe("what the button says in Japanese", () => {
  beforeEach(() => {
    mocks.getUserLanguage.mockResolvedValue("ja");
  });

  it("says a run succeeded", async () => {
    mocks.enqueueRoutine.mockResolvedValue({ id: "run-1", status: "completed" });

    expect(await runRoutineAction(null, form("worker-1"))).toEqual({
      status: "success",
      message: "「Daily digest」を実行しました。",
    });
  });

  it("says a worker is busy rather than broken", async () => {
    mocks.enqueueRoutine.mockRejectedValue(
      new ExecutionSuppressedError("worker-1"),
    );

    expect(await runRoutineAction(null, form("worker-1"))).toEqual({
      status: "error",
      message: "「Daily digest」は実行中です。",
    });
  });

  it("says a run failed", async () => {
    mocks.enqueueRoutine.mockResolvedValue({ id: "run-1", status: "failed" });

    expect(await runRoutineAction(null, form("worker-1"))).toEqual({
      status: "error",
      message: "「Daily digest」の実行に失敗しました。",
    });
  });

  it("says an outcome could not be recorded", async () => {
    mocks.enqueueRoutine.mockRejectedValue(
      new RunPersistenceError("completed", "run-1", new Error("write failed")),
    );

    expect(await runRoutineAction(null, form("worker-1"))).toEqual({
      status: "error",
      message: "「Daily digest」は開始しましたが、結果を記録できませんでした。",
    });
  });

  it("says a worker was not found", async () => {
    mocks.getRoutine.mockResolvedValue(null);

    expect(await runRoutineAction(null, form("worker-1"))).toEqual({
      status: "error",
      message: "Worker が見つかりません。",
    });
  });

  it("says a worker was deleted", async () => {
    mocks.deleteRoutine.mockResolvedValue(true);

    expect(await deleteWorkerAction("worker-1", null)).toEqual({
      status: "success",
      message: "Worker を削除しました。",
    });
  });

  it("says a delete matched nothing", async () => {
    mocks.deleteRoutine.mockResolvedValue(false);

    expect(await deleteWorkerAction("worker-1", null)).toEqual({
      status: "error",
      message: "Worker が見つかりません。",
    });
  });

  it("says a delete failed", async () => {
    mocks.deleteRoutine.mockRejectedValue(new Error("connection lost"));

    expect(await deleteWorkerAction("worker-1", null)).toEqual({
      status: "error",
      message: "Worker を削除できませんでした。",
    });
  });

  /**
   * A run that produced something says so; **what it produced is not in the
   * toast**, in either language. Output and the reason a failure gives are
   * stored on the execution and shown on its own page.
   */
  it("leaves the worker's own name exactly as stored", async () => {
    mocks.getRoutine.mockResolvedValue({
      id: "worker-1",
      name: "宝塚市 パブリック・コメント",
    });
    mocks.enqueueRoutine.mockResolvedValue({ id: "run-1", status: "completed" });

    const result = await runRoutineAction(null, form("worker-1"));

    expect(result?.message).toContain("宝塚市 パブリック・コメント");
  });
});

/**
 * What a submission with nothing in it gets, and who it gets it from.
 *
 * **This is the contract as it stood before the messages were translated, and
 * it is left exactly where it was.** A form that submitted no worker is
 * answered before anybody is authenticated — so a visitor with no session gets
 * the same sentence a signed-in one does, rather than being sent to sign in.
 *
 * The consequence is that this one message is always English: whose language
 * to answer in cannot be asked before knowing whose request it is, and reading
 * the account row first would change what the action *does*. Everything past
 * this guard is translated.
 */
describe("a submission with no worker in it", () => {
  it("is answered without authenticating anybody", async () => {
    const result = await runRoutineAction(null, form(""));

    expect(result).toEqual({
      status: "error",
      message: "No worker selected.",
    });
    expect(mocks.requireUserId).not.toHaveBeenCalled();
    expect(mocks.getUserLanguage).not.toHaveBeenCalled();
    expect(mocks.getRoutine).not.toHaveBeenCalled();
    expect(mocks.enqueueRoutine).not.toHaveBeenCalled();
  });

  it("answers a visitor with no session the same way", async () => {
    mocks.requireUserId.mockImplementation(() => {
      throw new RedirectSignal("/");
    });

    expect(await runRoutineAction(null, form(""))).toEqual({
      status: "error",
      message: "No worker selected.",
    });
  });

  /** A worker that *was* named still authenticates first, as it always did. */
  it("sends a visitor with no session to sign in when one was named", async () => {
    mocks.requireUserId.mockImplementation(() => {
      throw new RedirectSignal("/");
    });

    await expect(
      runRoutineAction(null, form("worker-1")),
    ).rejects.toBeInstanceOf(RedirectSignal);
    expect(mocks.getRoutine).not.toHaveBeenCalled();
    expect(mocks.enqueueRoutine).not.toHaveBeenCalled();
  });

  /**
   * The same answer for a signed-in account, in either language. It is not
   * translated, and this fixes that rather than leaving it to drift.
   */
  it.each(["en", "ja"])("says the same thing to a %s account", async (language) => {
    mocks.getUserLanguage.mockResolvedValue(language);

    expect(await runRoutineAction(null, form(""))).toEqual({
      status: "error",
      message: "No worker selected.",
    });
  });
});
