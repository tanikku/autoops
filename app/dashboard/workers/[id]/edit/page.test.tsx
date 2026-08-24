import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

/**
 * The edit form has to be told the same clock the hire form is.
 *
 * Editing is where a schedule is most often corrected, so a form that does not
 * say which zone `09:00` means is the same trap as on creation — and the worker
 * being edited may already be running at an hour nobody expected.
 */

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  getRoutineForEdit: vi.fn(),
  getUserTimezone: vi.fn(),
  getUserLanguage: vi.fn(),
  getWebsiteSource: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireUserId: mocks.requireUserId }));
vi.mock("@/lib/routines", () => ({
  getRoutineForEdit: mocks.getRoutineForEdit,
}));
vi.mock("@/lib/users", () => ({
  getUserTimezone: mocks.getUserTimezone,
  getUserLanguage: mocks.getUserLanguage,
}));
vi.mock("@/lib/website-sources", () => ({
  getWebsiteSource: mocks.getWebsiteSource,
}));

const EditWorkerPage = (await import(
  "@/app/dashboard/workers/[id]/edit/page"
)).default;

const NOW = new Date("2026-08-20T08:50:29.000Z");

/** One prop, as it was handed to whichever component was given it. */
function passedProp(node: ReactNode, name: string): unknown {
  let found: unknown;

  const walk = (current: unknown): void => {
    if (found !== undefined) {
      return;
    }

    if (Array.isArray(current)) {
      current.forEach(walk);
      return;
    }

    if (!current || typeof current !== "object") {
      return;
    }

    const props = (current as { props?: Record<string, unknown> }).props;
    if (!props) {
      return;
    }

    if (name in props) {
      found = props[name];
      return;
    }

    walk(props.children);
  };

  walk(node);
  return found;
}

const passedTimezone = (node: ReactNode) => passedProp(node, "timezone");

function worker(overrides?: Record<string, unknown>) {
  return {
    id: "worker-1",
    userId: "user-1",
    name: "Watcher",
    description: "",
    prompt: "Tell me what changed.",
    kind: "prompt" as const,
    status: "active" as const,
    frequency: "daily" as const,
    runAtMinutes: null,
    runAtWeekday: null,
    runAtDay: null,
    nextRunAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function render() {
  return EditWorkerPage({ params: Promise.resolve({ id: "worker-1" }) });
}

beforeEach(() => {
  mocks.requireUserId.mockReset().mockResolvedValue("user-1");
  mocks.getUserTimezone.mockReset().mockResolvedValue("Asia/Tokyo");
  mocks.getUserLanguage.mockReset().mockResolvedValue("en");
  mocks.getRoutineForEdit.mockReset().mockResolvedValue(worker());
  mocks.getWebsiteSource.mockReset().mockResolvedValue(null);
  mocks.notFound.mockReset().mockImplementation(() => {
    throw new Error("not found");
  });
});

describe("edit worker page", () => {
  it("hands the account's timezone to the form", async () => {
    expect(passedTimezone(await render())).toBe("Asia/Tokyo");
  });

  it("reads it for the signed-in account", async () => {
    await render();

    expect(mocks.getUserTimezone).toHaveBeenCalledWith("user-1");
  });

  it("does the same for a website worker", async () => {
    mocks.getRoutineForEdit.mockResolvedValue(worker({ kind: "website" }));
    mocks.getWebsiteSource.mockResolvedValue({
      id: "source-1",
      routineId: "worker-1",
      url: "https://example.com/news",
      createdAt: NOW,
      updatedAt: NOW,
    });

    expect(passedTimezone(await render())).toBe("Asia/Tokyo");
  });
});

/**
 * The edit form is told its language the same way, and the worker inside it is
 * not affected by the answer.
 */
describe("the language the edit form is written in", () => {
  it("comes from the account", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");

    expect(passedProp(await render(), "language")).toBe("ja");
  });

  it("is read for the signed-in account", async () => {
    await render();

    expect(mocks.getUserLanguage).toHaveBeenCalledWith("user-1");
  });

  it("leaves the worker it is editing exactly as stored", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");
    mocks.getRoutineForEdit.mockResolvedValue(
      worker({ name: "Watcher", prompt: "Tell me what changed." }),
    );

    const passed = passedProp(await render(), "worker") as {
      name: string;
      prompt: string;
      kind: string;
    };

    expect(passed.name).toBe("Watcher");
    expect(passed.prompt).toBe("Tell me what changed.");
    // A kind is decided when a worker is hired, and no language changes it.
    expect(passed.kind).toBe("prompt");
  });
});
