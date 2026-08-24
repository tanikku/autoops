import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

/**
 * What a worker's page claims the worker is.
 *
 * Every website-specific thing on this page — the type it reports, the address
 * it names — is a claim about a stored value, and the stored value is a plain
 * string column. So the page reads the kind unrepaired: `getRoutine` would have
 * answered "prompt" for a row nothing can read, and a screen stating that has
 * said something it does not know.
 */

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  getRoutineWithStoredKind: vi.fn(),
  listRunsForWorker: vi.fn(),
  getUserTimezone: vi.fn(),
  getUserLanguage: vi.fn(),
  getWebsiteSource: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireUserId: mocks.requireUserId }));
vi.mock("@/lib/routines", () => ({
  getRoutineWithStoredKind: mocks.getRoutineWithStoredKind,
}));
vi.mock("@/lib/runs", () => ({ listRunsForWorker: mocks.listRunsForWorker }));
vi.mock("@/lib/users", () => ({
  getUserTimezone: mocks.getUserTimezone,
  getUserLanguage: mocks.getUserLanguage,
}));
vi.mock("@/lib/website-sources", () => ({
  getWebsiteSource: mocks.getWebsiteSource,
}));

const WorkerDetailPage = (await import("@/app/dashboard/workers/[id]/page"))
  .default;

class NotFoundSignal extends Error {}

const NOW = new Date("2026-08-13T00:00:00.000Z");

/** Every `label` in the returned tree, paired with what sits next to it. */
function labelled(node: ReactNode): Record<string, unknown> {
  const found: Record<string, unknown> = {};

  const walk = (current: unknown): void => {
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

    if (typeof props.label === "string") {
      found[props.label] = props.value;
    }

    walk(props.children);
  };

  walk(node);
  return found;
}

/** Every string the page put on screen itself, headings and values alike. */
function text(node: ReactNode): string[] {
  const found: string[] = [];

  const walk = (current: unknown): void => {
    if (typeof current === "string") {
      found.push(current);
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

    for (const value of Object.values(props)) {
      walk(value);
    }
  };

  walk(node);
  return found;
}

function worker(overrides?: Record<string, unknown>) {
  return {
    id: "worker-1",
    userId: "user-1",
    name: "Watcher",
    description: "",
    prompt: "Tell me what changed.",
    kind: "prompt",
    status: "draft" as const,
    frequency: "manual" as const,
    runAtMinutes: null,
    runAtWeekday: null,
    runAtDay: null,
    nextRunAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const SOURCE = {
  id: "source-1",
  routineId: "worker-1",
  url: "https://example.com/news",
  createdAt: NOW,
  updatedAt: NOW,
};

function render() {
  return WorkerDetailPage({ params: Promise.resolve({ id: "worker-1" }) });
}

beforeEach(() => {
  mocks.requireUserId.mockReset().mockResolvedValue("user-1");
  mocks.getUserTimezone.mockReset().mockResolvedValue("UTC");
  // This page's own wording is Day 2B's; what it takes a language for is the
  // health summary and the Run button it borrows from the dashboard.
  mocks.getUserLanguage.mockReset().mockResolvedValue("en");
  mocks.listRunsForWorker.mockReset().mockResolvedValue([]);
  mocks.getWebsiteSource.mockReset().mockResolvedValue(null);
  mocks.getRoutineWithStoredKind
    .mockReset()
    .mockResolvedValue({ routine: worker(), kind: "prompt" });
  mocks.notFound.mockReset().mockImplementation(() => {
    throw new NotFoundSignal();
  });
});

describe("worker detail — a prompt worker", () => {
  it("says what it is", async () => {
    expect(labelled(await render())["Worker type"]).toBe("Prompt");
  });

  it("names no page, and asks for none", async () => {
    const shown = text(await render());

    expect(shown).not.toContain("Watched page");
    expect(shown).not.toContain("Change instructions");
    expect(mocks.getWebsiteSource).not.toHaveBeenCalled();
  });

  it("keeps the rest of the worker's surface", async () => {
    const sections = labelled(await render());

    expect(sections).toHaveProperty("Frequency");
    expect(sections).toHaveProperty("Next Run");
    expect(sections).toHaveProperty("Last Run");
    expect(sections).toHaveProperty("Created At");
    expect(sections).toHaveProperty("Updated At");
  });
});

describe("worker detail — a website worker", () => {
  beforeEach(() => {
    mocks.getRoutineWithStoredKind.mockResolvedValue({
      routine: worker({ kind: "website" }),
      kind: "website",
    });
    mocks.getWebsiteSource.mockResolvedValue(SOURCE);
  });

  it("says what it is", async () => {
    expect(labelled(await render())["Worker type"]).toBe("Website");
  });

  it("shows the address it watches, as stored", async () => {
    const shown = text(await render());

    expect(shown).toContain("Watched page");
    expect(shown).toContain("https://example.com/news");
  });

  it("shows the instructions under a heading that says what they are for", async () => {
    const shown = text(await render());

    expect(shown).toContain("Change instructions");
    expect(shown).toContain("Tell me what changed.");
  });

  it("asks for the page as this account, and only for a website worker", async () => {
    await render();

    expect(mocks.getWebsiteSource).toHaveBeenCalledWith("worker-1", "user-1");
  });

  it("keeps the rest of the worker's surface", async () => {
    const sections = labelled(await render());

    expect(sections).toHaveProperty("Frequency");
    expect(sections).toHaveProperty("Next Run");
    expect(sections).toHaveProperty("Last Run");
  });

  /**
   * A website worker with nothing to watch should not exist. Rendering it as a
   * prompt worker would hide that behind a screen that looks entirely ordinary.
   */
  it("404s rather than showing a worker with no page as a prompt worker", async () => {
    mocks.getWebsiteSource.mockResolvedValue(null);

    await expect(render()).rejects.toBeInstanceOf(NotFoundSignal);
  });
});

describe("worker detail — a kind nothing recognises", () => {
  beforeEach(() => {
    mocks.getRoutineWithStoredKind.mockResolvedValue({
      routine: worker({ kind: "prompt" }),
      kind: null,
    });
  });

  it("says so rather than picking one", async () => {
    expect(labelled(await render())["Worker type"]).toBe("Unrecognised");
  });

  it("claims nothing about a page", async () => {
    const shown = text(await render());

    expect(shown).not.toContain("Watched page");
    expect(shown).not.toContain("Change instructions");
    expect(mocks.getWebsiteSource).not.toHaveBeenCalled();
  });
});

describe("worker detail — a worker that is not this account's", () => {
  it("404s", async () => {
    mocks.getRoutineWithStoredKind.mockResolvedValue(null);

    await expect(render()).rejects.toBeInstanceOf(NotFoundSignal);
  });
});
