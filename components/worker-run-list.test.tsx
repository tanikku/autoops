import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkerRunList } from "@/components/worker-run-list";
import type { WorkerRun } from "@/types";

/**
 * A worker's own runs, and the route each row is.
 *
 * **What this list is for is reaching an execution, not describing one.** The
 * account's activity list is bounded to its newest twenty rows, so a run older
 * than that was recorded and unreachable — no screen carried its id. Every row
 * here is that id, and the reason a failed run gives is still shown where it
 * has always been: on the execution's own page.
 *
 * Rendered to a string, the boundary this project's component tests work at.
 */

const NOW = new Date("2026-08-10T12:00:00.000Z");

const run = (overrides: Partial<WorkerRun> = {}): WorkerRun => ({
  id: "run-1",
  status: "completed",
  startedAt: NOW,
  ...overrides,
});

const list = (
  runs: WorkerRun[],
  language = "en",
  timezone = "UTC",
  now: Date = NOW,
) =>
  renderToStaticMarkup(
    <WorkerRunList
      runs={runs}
      timezone={timezone}
      language={language}
      now={now}
    />,
  );

describe("a worker with no runs", () => {
  it("says so rather than showing an empty card", () => {
    const html = list([]);

    expect(html).toContain("This worker has not run yet.");
    expect(html).not.toContain("/dashboard/runs/");
  });

  it("says so in Japanese", () => {
    expect(list([], "ja")).toContain("この Worker はまだ実行されていません。");
  });
});

describe("a worker with runs", () => {
  it.each([
    ["completed", "Completed"],
    ["failed", "Failed"],
    ["running", "Running"],
  ] as const)("names a %o run", (status, label) => {
    expect(list([run({ status })])).toContain(`>${label}<`);
  });

  it.each([
    ["completed", "完了"],
    ["failed", "失敗"],
    ["running", "実行中"],
  ] as const)("names a %o run in Japanese", (status, label) => {
    expect(list([run({ status })], "ja")).toContain(`>${label}<`);
  });

  /**
   * **The point of the list.** Without a link there is no route, and the run's
   * page — the only place the failure's reason is shown — stays unreachable.
   */
  it("links every row to its own execution", () => {
    const html = list([
      run({ id: "run-a" }),
      run({ id: "run-b", status: "failed" }),
      run({ id: "run-c", status: "running" }),
    ]);

    expect(html).toContain('href="/dashboard/runs/run-a"');
    expect(html).toContain('href="/dashboard/runs/run-b"');
    expect(html).toContain('href="/dashboard/runs/run-c"');
  });

  it("draws one row per run, in the order it was given", () => {
    const html = list([run({ id: "first" }), run({ id: "second" })]);

    expect(html.indexOf("/dashboard/runs/first")).toBeLessThan(
      html.indexOf("/dashboard/runs/second"),
    );
  });

  it("shows when each run started, in the account's zone", () => {
    expect(list([run()], "en", "UTC")).toContain("2026-08-10 12:00:00 UTC");
  });

  it("writes the timestamp the same way in either language", () => {
    const stamp = (language: string) =>
      list([run()], language).match(/2026-08-10[^<]*/)?.[0];

    expect(stamp("ja")).toBe(stamp("en"));
  });
});

/**
 * What this list does not carry.
 *
 * A run's output and the reason a failed one gives belong to the execution, and
 * the type this component takes has no room for either — which is what keeps
 * the query from reading them.
 */
describe("what the list leaves to the execution's own page", () => {
  it("shows neither an output nor a diagnostic", () => {
    const html = list([run({ status: "failed" }), run({ id: "run-2" })]);

    expect(html).not.toContain("Error");
    expect(html).not.toContain("Output");
  });

  /** The worker's name is the heading of the page this sits on. */
  it("does not repeat the worker's name on every row", () => {
    const html = list([run()]);

    expect(html).not.toContain("Watcher");
  });
});

/**
 * A run that has been going for longer than one reasonably takes.
 *
 * The same note the account's activity list shows, from the same threshold —
 * and, as there, the badge and the link are untouched because the stored status
 * has not changed.
 */
describe("a run that has been running too long", () => {
  const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
  const started = (msAgo: number) => new Date(NOW.getTime() - msAgo);
  const running = (msAgo: number) =>
    run({ status: "running", startedAt: started(msAgo) });

  it("says nothing about a run that started a moment ago", () => {
    const html = list([running(0)]);

    expect(html).toContain(">Running<");
    expect(html).not.toContain("Running for longer than expected");
  });

  it("says nothing at exactly the threshold", () => {
    expect(list([running(FIFTEEN_MINUTES_MS)])).not.toContain(
      "Running for longer than expected",
    );
  });

  it("says so one millisecond past it", () => {
    expect(list([running(FIFTEEN_MINUTES_MS + 1)])).toContain(
      "Running for longer than expected",
    );
  });

  it("keeps the Running badge and the link", () => {
    const html = list([running(FIFTEEN_MINUTES_MS + 1)]);

    expect(html).toContain(">Running<");
    expect(html).not.toContain(">Failed<");
    expect(html).toContain('href="/dashboard/runs/run-1"');
  });

  it("says so in Japanese", () => {
    const html = list([running(FIFTEEN_MINUTES_MS + 1)], "ja");

    expect(html).toContain("想定より長く実行が続いています");
    expect(html).toContain(">実行中<");
  });

  it.each(["completed", "failed"] as const)(
    "says nothing about an old %o run",
    (status) => {
      const html = list([
        run({ status, startedAt: started(FIFTEEN_MINUTES_MS * 100) }),
      ]);

      expect(html).not.toContain("Running for longer than expected");
    },
  );

  it("judges every row against the same moment", () => {
    const html = list([
      running(FIFTEEN_MINUTES_MS + 1),
      { ...running(0), id: "run-2" },
    ]);

    expect(html.match(/Running for longer than expected/g)).toHaveLength(1);
  });
});
