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
