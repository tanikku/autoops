import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

/**
 * What an execution's page is allowed to say it sent.
 *
 * A prompt run's request is reproducible: the worker's prompt with its
 * variables filled in, which is why it is rebuilt here rather than stored. A
 * website run's is not. It carries a platform instruction, the worker's
 * instructions inside it, and a bounded excerpt of what actually changed — and
 * none of that is kept, so the excerpt could not be recovered at any price.
 *
 * **The failure this file exists to prevent is a confident one.** Running the
 * prompt reconstruction over a website run produces a perfectly plausible block
 * of text under a heading claiming it is what was sent. Nothing about it looks
 * wrong.
 */

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  getRun: vi.fn(),
  getUserTimezone: vi.fn(),
  getUserLanguage: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
// The page renders the dashboard chrome, which reaches the auth module on the
// way in. Nothing here asks it anything — this only keeps importing the page
// from pulling in a framework runtime a test has no use for.
vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireUserId: mocks.requireUserId }));
vi.mock("@/lib/runs", () => ({ getRun: mocks.getRun }));
vi.mock("@/lib/users", () => ({
  getUserTimezone: mocks.getUserTimezone,
  getUserLanguage: mocks.getUserLanguage,
}));

const RunDetailPage = (await import("@/app/dashboard/runs/[id]/page")).default;

class NotFoundSignal extends Error {}

/**
 * Every `label` in the returned tree, paired with what sits next to it.
 *
 * The page builds its sections from local components it never invokes, so the
 * headings and their contents are readable straight off the element tree — no
 * renderer, no DOM, and nothing about how any of it looks.
 */
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

function run(overrides?: Record<string, unknown>) {
  return {
    id: "run-1",
    routineId: "worker-1",
    userId: "user-1",
    status: "completed",
    startedAt: new Date("2026-08-13T00:00:00.000Z"),
    finishedAt: new Date("2026-08-13T00:00:05.000Z"),
    output: "What the model said.",
    errorMessage: null,
    routineName: "Watcher",
    routinePrompt: "Summarise {{today}}.",
    routineKind: "prompt",
    ...overrides,
  };
}

function render() {
  return RunDetailPage({ params: Promise.resolve({ id: "run-1" }) });
}

beforeEach(() => {
  mocks.requireUserId.mockReset().mockResolvedValue("user-1");
  mocks.getUserTimezone.mockReset().mockResolvedValue("UTC");
  // English by default, so the assertions above stay about which sections a
  // run has rather than about what they are called.
  mocks.getUserLanguage.mockReset().mockResolvedValue("en");
  mocks.getRun.mockReset().mockResolvedValue(run());
  mocks.notFound.mockReset().mockImplementation(() => {
    throw new NotFoundSignal();
  });
});

describe("run detail — a prompt run", () => {
  it("shows the prompt and what it rendered to", async () => {
    const sections = labelled(await render());

    expect(sections.Prompt).toBe("Summarise {{today}}.");
    expect(sections["Rendered Prompt"]).toBe("Summarise 2026-08-13.");
  });

  it("shows the output", async () => {
    const sections = labelled(await render());

    expect(sections.Output).toBe("What the model said.");
    expect(sections).not.toHaveProperty("Error");
  });

  it("shows the reason a failed run failed, in place of an output", async () => {
    mocks.getRun.mockResolvedValue(
      run({ status: "failed", output: "", errorMessage: "Provider said no." }),
    );

    const sections = labelled(await render());

    expect(sections.Error).toBe("Provider said no.");
    expect(sections).not.toHaveProperty("Output");
  });
});

describe("run detail — a website run", () => {
  const website = (overrides?: Record<string, unknown>) =>
    run({
      routineKind: "website",
      routinePrompt: "Tell me what changed.",
      ...overrides,
    });

  it("never claims to show the request that was sent", async () => {
    mocks.getRun.mockResolvedValue(website());

    const sections = labelled(await render());

    expect(sections).not.toHaveProperty("Rendered Prompt");
  });

  it("names the instructions for what they are", async () => {
    mocks.getRun.mockResolvedValue(website());

    const sections = labelled(await render());

    expect(sections["Change instructions"]).toBe("Tell me what changed.");
    expect(sections).not.toHaveProperty("Prompt");
  });

  it.each([
    ["an AI answer", "The price moved to £12."],
    ["a first check", "Website baseline is not established yet."],
    ["a check that found nothing", "Website content has not changed."],
  ])("shows %s as the output", async (_label, output) => {
    mocks.getRun.mockResolvedValue(website({ output }));

    expect(labelled(await render()).Output).toBe(output);
  });

  it("shows the error of a failed check", async () => {
    mocks.getRun.mockResolvedValue(
      website({ status: "failed", output: "", errorMessage: "Fetch failed." }),
    );

    const sections = labelled(await render());

    expect(sections.Error).toBe("Fetch failed.");
    expect(sections).not.toHaveProperty("Rendered Prompt");
  });
});

/**
 * A kind nothing recognises is not a prompt run. Guessing would put the
 * reconstruction back, under a heading that would still be wrong.
 */
describe("run detail — a worker of an unrecognised kind", () => {
  beforeEach(() => {
    mocks.getRun.mockResolvedValue(run({ routineKind: null }));
  });

  it("shows neither a prompt nor a rendered one", async () => {
    const sections = labelled(await render());

    expect(sections).not.toHaveProperty("Prompt");
    expect(sections).not.toHaveProperty("Rendered Prompt");
    expect(sections).not.toHaveProperty("Change instructions");
  });

  it("still shows what the run did", async () => {
    const sections = labelled(await render());

    expect(sections.Worker).toBe("Watcher");
    expect(sections.Output).toBe("What the model said.");
  });
});

describe("run detail — a run that is not this account's", () => {
  it("404s", async () => {
    mocks.getRun.mockResolvedValue(null);

    await expect(render()).rejects.toBeInstanceOf(NotFoundSignal);
  });
});

/**
 * The same page, in Japanese.
 *
 * **The headings move and the evidence does not.** What a run sent, what it
 * produced and the reason a failed one gives are stored text — some of it the
 * provider's words — and a translated page shows them exactly as recorded.
 * Which sections appear is still decided by the worker's kind.
 */
describe("run detail in Japanese", () => {
  beforeEach(() => {
    mocks.getUserLanguage.mockResolvedValue("ja");
  });

  it("names a prompt run's sections in Japanese", async () => {
    const sections = labelled(await render());

    expect(sections["プロンプト"]).toBe("Summarise {{today}}.");
    expect(sections["展開後のプロンプト"]).toBe("Summarise 2026-08-13.");
    expect(sections).not.toHaveProperty("Prompt");
  });

  it("shows what the run produced, untranslated", async () => {
    const sections = labelled(await render());

    expect(sections["出力"]).toBe("What the model said.");
    expect(sections).not.toHaveProperty("エラー");
  });

  it("shows the provider's own words for a failure", async () => {
    mocks.getRun.mockResolvedValue(
      run({ status: "failed", output: "", errorMessage: "Provider said no." }),
    );

    const sections = labelled(await render());

    expect(sections["エラー"]).toBe("Provider said no.");
    expect(sections).not.toHaveProperty("出力");
  });

  it("still never claims to show what a website run sent", async () => {
    mocks.getRun.mockResolvedValue(
      run({ routineKind: "website", routinePrompt: "Tell me what changed." }),
    );

    const sections = labelled(await render());

    expect(sections["変更時の指示"]).toBe("Tell me what changed.");
    expect(sections).not.toHaveProperty("展開後のプロンプト");
    expect(sections).not.toHaveProperty("プロンプト");
  });

  it("shows neither for a kind it does not recognise", async () => {
    mocks.getRun.mockResolvedValue(run({ routineKind: null }));

    const sections = labelled(await render());

    expect(sections).not.toHaveProperty("プロンプト");
    expect(sections).not.toHaveProperty("展開後のプロンプト");
    expect(sections).not.toHaveProperty("変更時の指示");
    expect(sections["出力"]).toBe("What the model said.");
  });

  it("keeps the worker's name and the timestamps as they were", async () => {
    mocks.getUserLanguage.mockResolvedValue("en");
    const english = labelled(await render());

    mocks.getUserLanguage.mockResolvedValue("ja");
    const japanese = labelled(await render());

    // "Worker" is the product's own noun and is the same in both.
    expect(japanese.Worker).toBe(english.Worker);
    expect(japanese["開始日時"]).toBe(english["Started At"]);
    expect(japanese["終了日時"]).toBe(english["Finished At"]);
    expect(japanese["実行時間"]).toBe(english["Execution Time"]);
  });
});

/**
 * A run that has been going for longer than one reasonably takes.
 *
 * **A note beside the status, and nothing more.** The run is still `running`
 * and is still recorded that way: no finish time is invented, no reason is
 * made up, and nothing here calls it failed. It is the same sentence the
 * worker's health summary shows, from the same threshold — said on the page
 * somebody lands on when they click the run.
 */
describe("run detail — a run that has been running too long", () => {
  const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
  const CLOCK = new Date("2026-08-13T01:00:00.000Z");

  /** Only `Date` is faked: nothing here waits on a timer. */
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(CLOCK);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const runningFor = (ms: number) =>
    run({
      status: "running",
      startedAt: new Date(CLOCK.getTime() - ms),
      finishedAt: null,
      output: "",
    });

  it("says nothing about a run that started a moment ago", async () => {
    mocks.getRun.mockResolvedValue(runningFor(0));

    const shown = strings(await render());

    expect(shown).toContain("Running");
    expect(shown).not.toContain("Running for longer than expected");
  });

  it("says nothing at exactly the threshold", async () => {
    mocks.getRun.mockResolvedValue(runningFor(FIFTEEN_MINUTES_MS));

    expect(strings(await render())).not.toContain(
      "Running for longer than expected",
    );
  });

  it("says so one millisecond past it", async () => {
    mocks.getRun.mockResolvedValue(runningFor(FIFTEEN_MINUTES_MS + 1));

    expect(strings(await render())).toContain(
      "Running for longer than expected",
    );
  });

  /**
   * **Still a running run.** Saying it has taken a while must not turn into
   * saying it failed — there is no Error section, and the output section is
   * the one a run that has not failed gets.
   */
  it("adds no error section and no reason", async () => {
    mocks.getRun.mockResolvedValue(runningFor(FIFTEEN_MINUTES_MS + 1));

    const sections = labelled(await render());

    expect(sections).not.toHaveProperty("Error");
    expect(sections).toHaveProperty("Output");
    expect(sections["Finished At"]).toBe("—");
  });

  it("says so in Japanese", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");
    mocks.getRun.mockResolvedValue(runningFor(FIFTEEN_MINUTES_MS + 1));

    expect(strings(await render())).toContain("想定より長く実行が続いています");
  });

  it.each(["completed", "failed"] as const)(
    "says nothing about an old %o run",
    async (status) => {
      mocks.getRun.mockResolvedValue(
        run({
          status,
          startedAt: new Date(CLOCK.getTime() - FIFTEEN_MINUTES_MS * 100),
          errorMessage: status === "failed" ? "Provider said no." : null,
          output: status === "failed" ? "" : "What the model said.",
        }),
      );

      expect(strings(await render())).not.toContain(
        "Running for longer than expected",
      );
    },
  );
});

/** Every string the page put on screen itself. */
function strings(node: ReactNode): string[] {
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
