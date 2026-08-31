import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RecentRun, Routine } from "@/types";

/**
 * What the dashboard says, in each language.
 *
 * **Rendered to a string rather than clicked at**, which is the same boundary
 * the rest of this project's component tests work at: no DOM, no renderer
 * beyond the one React ships for the server, and no new dependency. What that
 * reaches is exactly what this Sprint changed — which words appear — and not
 * the thing it did not touch, which is what happens when you press them.
 *
 * **The dynamic halves are the point of half these tests.** A worker's name,
 * its description and a run's output are its owner's material: they have to
 * come through byte for byte in Japanese, because translating them would mean
 * the product rewriting what somebody wrote.
 */

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
// The Run button raises a toast through the notification provider, which is a
// context these tests have no reason to stand up: what a run *says back* is a
// server action message and is still English until a later day. Standing in for
// the hook keeps this file about the words on the buttons.
vi.mock("@/components/notification/use-action-result", () => ({
  useActionResult: () => {},
}));

const { OverviewCards } = await import("@/components/overview-cards");
const { RoutineCard } = await import("@/components/routine-card");
const { RunHistoryList } = await import("@/components/run-history-list");
const { WorkerHealthSummary } = await import("@/components/worker-health");

const NOW = new Date("2026-08-24T00:50:00.000Z");

const WORKER: Routine = {
  id: "worker-1",
  userId: "user-1",
  name: "宝塚市 パブリック・コメント",
  description: "A description the owner wrote",
  prompt: "Tell me what changed.",
  kind: "website",
  status: "active",
  frequency: "daily",
  runAtMinutes: 540,
  runAtWeekday: null,
  runAtDay: null,
  nextRunAt: NOW,
  emailNotificationsEnabled: false,
  createdAt: NOW,
  updatedAt: NOW,
};

const HEALTH = {
  lastResult: "completed" as const,
  lastRunAt: NOW,
  totalRuns: 3,
  totalFailures: 0,
  stuck: false,
};

/**
 * A prompt worker's row, carrying — deliberately — a sentence that a website
 * worker would have had translated. What keeps it in English is the kind: a
 * prompt worker's output is the account's material, whatever it happens to say.
 */
const RUN: RecentRun = {
  id: "run-1",
  status: "completed",
  startedAt: NOW,
  output: "Website baseline is not established yet.",
  routineName: "宝塚市 パブリック・コメント",
  routineKind: "prompt",
};

const OVERVIEW = {
  total: 2,
  active: 1,
  paused: 1,
  nextScheduledRun: NOW,
  nextScheduledRunOverdue: true,
  lastExecution: NOW,
};

const card = (language: string) =>
  renderToStaticMarkup(
    <RoutineCard
      routine={WORKER}
      health={HEALTH}
      timezone="UTC"
      language={language}
    />,
  );

const overview = (language: string) =>
  renderToStaticMarkup(
    <OverviewCards overview={OVERVIEW} timezone="UTC" language={language} />,
  );

const activity = (
  language: string,
  runs: RecentRun[] = [RUN],
  now: Date = NOW,
) =>
  renderToStaticMarkup(
    <RunHistoryList
      runs={runs}
      timezone="UTC"
      language={language}
      now={now}
    />,
  );

const health = (language: string, overrides = {}) =>
  renderToStaticMarkup(
    <WorkerHealthSummary
      health={{ ...HEALTH, ...overrides }}
      timezone="UTC"
      language={language}
    />,
  );

describe("the overview cards", () => {
  it("labels each figure in English", () => {
    const html = overview("en");

    expect(html).toContain("Total Workers");
    expect(html).toContain("Active Workers");
    expect(html).toContain("Paused Workers");
    expect(html).toContain("Next Scheduled Run");
    expect(html).toContain("Last Execution");
    expect(html).toContain("Scheduled run is overdue");
  });

  it("labels each figure in Japanese", () => {
    const html = overview("ja");

    expect(html).toContain("Worker 総数");
    expect(html).toContain("次回の予定実行");
    expect(html).toContain("最終実行");
    expect(html).toContain("予定時刻を過ぎています");
    expect(html).not.toContain("Total Workers");
  });

  it("says so in each language when there is nothing to show", () => {
    const empty = { ...OVERVIEW, nextScheduledRun: null, lastExecution: null };

    const en = renderToStaticMarkup(
      <OverviewCards overview={empty} timezone="UTC" language="en" />,
    );
    const ja = renderToStaticMarkup(
      <OverviewCards overview={empty} timezone="UTC" language="ja" />,
    );

    expect(en).toContain("None scheduled");
    expect(ja).toContain("予定なし");
    expect(ja).toContain("未実行");
  });

  /** Counts and timestamps are the same in both; only the labels move. */
  it("leaves the figures themselves alone", () => {
    for (const language of ["en", "ja"]) {
      const html = overview(language);
      expect(html).toContain(">2<");
      expect(html).toContain("2026-08-24 00:50 UTC");
    }
  });
});

describe("a worker card", () => {
  it("labels it in English", () => {
    const html = card("en");

    expect(html).toContain("Active");
    expect(html).toContain("Next Run");
    expect(html).toContain("Health");
    expect(html).toContain("Success");
    expect(html).toContain("View");
    expect(html).toContain("Run");
    expect(html).toContain("Every day at 09:00");
    expect(html).toContain("3 runs");
    expect(html).toContain("0 failures");
  });

  it("labels it in Japanese", () => {
    const html = card("ja");

    expect(html).toContain("稼働中");
    expect(html).toContain("次回実行");
    expect(html).toContain("状態");
    expect(html).toContain("成功");
    expect(html).toContain("詳細");
    expect(html).toContain("実行 3 回");
    expect(html).toContain("失敗 0 回");
    expect(html).toContain("毎日 09:00");
  });

  /**
   * The half that is not the product's to write.
   *
   * The card shows the worker's name and its cadence; the description it was
   * given is not on this screen at all, which is why only the name is asserted.
   */
  it("leaves the owner's own words untouched in Japanese", () => {
    const html = card("ja");

    expect(html).toContain("宝塚市 パブリック・コメント");
  });

  it("keeps the timestamp exactly as it was", () => {
    expect(card("en")).toContain("2026-08-24 00:50 UTC");
    expect(card("ja")).toContain("2026-08-24 00:50 UTC");
  });

  it("says a worker with no pending slot runs by hand", () => {
    const manual = { ...WORKER, nextRunAt: null, frequency: "manual" as const };

    expect(
      renderToStaticMarkup(
        <RoutineCard routine={manual} timezone="UTC" language="en" />,
      ),
    ).toContain("Manual");
    expect(
      renderToStaticMarkup(
        <RoutineCard routine={manual} timezone="UTC" language="ja" />,
      ),
    ).toContain("手動");
  });

  it.each([
    ["active", "Active", "稼働中"],
    ["paused", "Paused", "一時停止"],
    ["draft", "Draft", "下書き"],
  ] as const)("names the %o status in both", (status, english, japanese) => {
    const routine = { ...WORKER, status };

    expect(
      renderToStaticMarkup(
        <RoutineCard routine={routine} timezone="UTC" language="en" />,
      ),
    ).toContain(english);
    expect(
      renderToStaticMarkup(
        <RoutineCard routine={routine} timezone="UTC" language="ja" />,
      ),
    ).toContain(japanese);
  });
});

describe("the health summary", () => {
  it.each([
    ["completed", "Success", "成功"],
    ["failed", "Failed", "失敗"],
    ["running", "Running", "実行中"],
  ] as const)("names a %o last run in both", (result, english, japanese) => {
    expect(health("en", { lastResult: result })).toContain(english);
    expect(health("ja", { lastResult: result })).toContain(japanese);
  });

  it("says a worker has never run", () => {
    expect(health("en", { lastResult: null, lastRunAt: null })).toContain(
      "Never run",
    );
    expect(health("ja", { lastResult: null, lastRunAt: null })).toContain(
      "未実行",
    );
  });

  it("warns about a run that is taking too long", () => {
    expect(health("en", { stuck: true })).toContain(
      "Running for longer than expected",
    );
    expect(health("ja", { stuck: true })).toContain(
      "想定より長く実行が続いています",
    );
  });

  /** English inflects the noun; Japanese does not, and neither is glued. */
  it("counts one run without saying 1 runs", () => {
    const one = { totalRuns: 1, totalFailures: 1 };

    expect(health("en", one)).toContain("1 run ");
    expect(health("en", one)).toContain("1 failure");
    expect(health("en", one)).not.toContain("1 runs");
    expect(health("ja", one)).toContain("実行 1 回");
  });
});

describe("the activity list", () => {
  it("labels a run in English", () => {
    expect(activity("en")).toContain("Completed");
  });

  it("labels a run in Japanese", () => {
    const html = activity("ja");

    expect(html).toContain("完了");
    expect(html).not.toContain(">Completed<");
  });

  /**
   * What a run produced is stored data. It is shown as it was written, in
   * whichever language it was written in.
   */
  it("never touches what a run produced", () => {
    for (const language of ["en", "ja"]) {
      const html = activity(language);
      expect(html).toContain("Website baseline is not established yet.");
      expect(html).toContain("宝塚市 パブリック・コメント");
    }
  });

  /**
   * **The two sentences a website worker writes about itself are ours.** They
   * live in the same column as what a model produces, and the kind is what
   * tells them apart — which is why the row carries it.
   */
  it.each([
    ["a first check", "Website baseline is not established yet.", "サイトの初回状態を記録しました。"],
    ["a check that found nothing", "Website content has not changed.", "サイトの内容に変更はありませんでした。"],
  ])("reads %s in the account's language", (_label, stored, japanese) => {
    const runs = [{ ...RUN, output: stored, routineKind: "website" as const }];

    expect(activity("en", runs)).toContain(stored);

    const ja = activity("ja", runs);
    expect(ja).toContain(japanese);
    expect(ja).not.toContain(stored);
  });

  it("still shows a website worker's AI answer as it was written", () => {
    const summary = "The consultation deadline moved.";
    const runs = [{ ...RUN, output: summary, routineKind: "website" as const }];

    for (const language of ["en", "ja"]) {
      expect(activity(language, runs)).toContain(summary);
    }
  });

  it("says there is nothing yet, in each language", () => {
    expect(activity("en", [])).toContain("No activity yet");
    expect(activity("ja", [])).toContain("実行履歴はまだありません");
  });
});

/**
 * A language nobody planned for still renders a page — in English, rather than
 * in placeholders.
 */
describe("a language this version does not know", () => {
  it("falls back rather than breaking the dashboard", () => {
    const html = card("fr");

    expect(html).toContain("Active");
    expect(html).toContain("Next Run");
    expect(html).not.toContain("{count}");
  });
});

/**
 * A run that has been going for longer than one reasonably takes.
 *
 * **The row still says `running`, because it still is.** Nothing here changes
 * what is stored, what the run will be recorded as, or whether anything retries
 * it — the note says only that the row has been in this state longer than a run
 * normally lasts. The same sentence the worker's health summary uses, from the
 * same threshold.
 */
describe("a run that has been running too long", () => {
  const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
  const running = (startedAt: Date): RecentRun => ({
    ...RUN,
    status: "running",
    startedAt,
    output: "",
  });

  const started = (msAgo: number) => new Date(NOW.getTime() - msAgo);

  it("says nothing about a run that started a moment ago", () => {
    const html = activity("en", [running(started(0))]);

    expect(html).toContain(">Running<");
    expect(html).not.toContain("Running for longer than expected");
  });

  it("says nothing at exactly the threshold", () => {
    const html = activity("en", [running(started(FIFTEEN_MINUTES_MS))]);

    expect(html).not.toContain("Running for longer than expected");
  });

  it("says so one millisecond past it", () => {
    const html = activity("en", [running(started(FIFTEEN_MINUTES_MS + 1))]);

    expect(html).toContain("Running for longer than expected");
  });

  /** The badge is untouched: the stored status has not changed. */
  it("keeps the Running badge and the link", () => {
    const html = activity("en", [running(started(FIFTEEN_MINUTES_MS + 1))]);

    expect(html).toContain(">Running<");
    expect(html).not.toContain(">Failed<");
    expect(html).toContain("/dashboard/runs/run-1");
  });

  it("says so in Japanese", () => {
    const html = activity("ja", [running(started(FIFTEEN_MINUTES_MS + 1))]);

    expect(html).toContain("想定より長く実行が続いています");
    expect(html).toContain(">実行中<");
  });

  it.each(["completed", "failed"] as const)(
    "says nothing about an old %o run",
    (status) => {
      const html = activity("en", [
        { ...RUN, status, startedAt: started(FIFTEEN_MINUTES_MS * 100) },
      ]);

      expect(html).not.toContain("Running for longer than expected");
    },
  );

  /** Every row on one render is judged against the same instant. */
  it("judges every row against the same moment", () => {
    const html = activity("en", [
      running(started(FIFTEEN_MINUTES_MS + 1)),
      { ...running(started(0)), id: "run-2" },
    ]);

    expect(html.match(/Running for longer than expected/g)).toHaveLength(1);
  });
});
