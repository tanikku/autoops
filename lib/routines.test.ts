import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What a stored row is allowed to become on the way out.
 *
 * **`kind` is the reason this file exists.** The column is a plain string, as
 * `status` and `frequency` are, so the database can hold a value the
 * application has never heard of — a row written by a newer deployment, or by
 * hand. What such a row turns into is a decision, and the direction it falls in
 * is a safety property rather than a cosmetic one: `prompt` reaches nothing
 * outside the process, and `website` fetches.
 */

const mocks = vi.hoisted(() => ({ findFirst: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: { routine: { findFirst: mocks.findFirst } },
}));

const { getRoutineWithStoredKind, toRoutine } = await import("@/lib/routines");

const NOW = new Date("2026-08-13T12:00:00.000Z");

/** A row as Prisma hands it over: every narrowed column still a bare string. */
function record(overrides: Record<string, unknown> = {}) {
  return {
    id: "worker-1",
    userId: "user-1",
    name: "Worker",
    description: "",
    prompt: "",
    kind: "prompt",
    status: "draft",
    frequency: "manual",
    runAtMinutes: null,
    runAtWeekday: null,
    runAtDay: null,
    nextRunAt: null,
    executionOwner: null,
    executionLeaseUntil: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Parameters<typeof toRoutine>[0];
}

describe("the kind a worker comes back as", () => {
  it.each(["prompt", "website"])("keeps %s, which it recognises", (kind) => {
    expect(toRoutine(record({ kind })).kind).toBe(kind);
  });

  /**
   * **Every unreadable value becomes `prompt`, and that direction is the
   * point.** A worker AutoOps cannot classify must not be one that opens
   * connections: falling back to `website` would mean a typo, a partial
   * deployment, or a hand-edited row could start a worker fetching. Falling
   * back to `prompt` costs a confusing answer at worst.
   */
  it.each(["", "Website", "WEBSITE", "rss", "prompt ", "constructor", "null"])(
    "falls back to prompt for %o",
    (kind) => {
      expect(toRoutine(record({ kind })).kind).toBe("prompt");
    },
  );

  /**
   * The fallback is not a permission check, and nothing should come to rely on
   * it as one. **Execution has to branch on the kind explicitly** and refuse a
   * `website` worker with no source, rather than letting it slide back into
   * running its prompt — which would answer confidently about a page nobody
   * read. This test exists to keep that sentence attached to the behaviour.
   */
  it("is a display default, so a website worker still reports itself as one", () => {
    expect(toRoutine(record({ kind: "website" })).kind).toBe("website");
  });
});

describe("what else the row carries outwards", () => {
  it("does not send execution ownership to whoever asked for a worker", () => {
    const routine = toRoutine(
      record({ executionOwner: "token-a", executionLeaseUntil: NOW }),
    );

    expect(routine).not.toHaveProperty("executionOwner");
    expect(routine).not.toHaveProperty("executionLeaseUntil");
  });
});

/**
 * The same column, read without the repair.
 *
 * `toRoutine` answers `prompt` for anything it cannot read, and that is right
 * for a screen that has to render something. It is wrong wherever the kind
 * decides what happens next — a page stating "Prompt" about a row nobody can
 * read has said something it does not know, and a form offering to save it
 * would write the guess in. This is what those boundaries ask instead.
 */
describe("reading the kind as stored", () => {
  beforeEach(() => {
    mocks.findFirst.mockReset();
  });

  it.each(["prompt", "website"])("reports %s, which it recognises", async (kind) => {
    mocks.findFirst.mockResolvedValue(record({ kind }));

    const found = await getRoutineWithStoredKind("worker-1", "user-1");

    expect(found?.kind).toBe(kind);
    expect(found?.routine.id).toBe("worker-1");
  });

  it.each(["", "Website", "rss", "webhook", "prompt "])(
    "reports %o as no kind at all, rather than as prompt",
    async (kind) => {
      mocks.findFirst.mockResolvedValue(record({ kind }));

      expect((await getRoutineWithStoredKind("worker-1", "user-1"))?.kind).toBe(
        null,
      );
    },
  );

  /**
   * The worker still comes back, because a page has to show something: the
   * display default lives on `routine.kind`, and the honest answer lives beside
   * it. Callers that decide anything read the second one.
   */
  it("still hands back the worker, with the display default intact", async () => {
    mocks.findFirst.mockResolvedValue(record({ kind: "webhook" }));

    const found = await getRoutineWithStoredKind("worker-1", "user-1");

    expect(found?.routine.kind).toBe("prompt");
    expect(found?.kind).toBeNull();
  });

  it("scopes the read to the owner", async () => {
    mocks.findFirst.mockResolvedValue(null);

    expect(await getRoutineWithStoredKind("worker-1", "user-1")).toBeNull();
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { id: "worker-1", userId: "user-1" },
    });
  });
});
