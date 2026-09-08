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
  summarizeRunsForWorker: vi.fn(),
  listRunsForWorkerPage: vi.fn(),
  getUserTimezone: vi.fn(),
  getUserLanguage: vi.fn(),
  getWebsiteSource: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
const metadataMocks = vi.hoisted(() => ({ getDocumentLanguage: vi.fn() }));

vi.mock("@/lib/i18n/server", () => ({
  getDocumentLanguage: metadataMocks.getDocumentLanguage,
}));

vi.mock("@/lib/session", () => ({ requireUserId: mocks.requireUserId }));
vi.mock("@/lib/routines", () => ({
  getRoutineWithStoredKind: mocks.getRoutineWithStoredKind,
}));
vi.mock("@/lib/runs", () => ({
  summarizeRunsForWorker: mocks.summarizeRunsForWorker,
  listRunsForWorkerPage: mocks.listRunsForWorkerPage,
}));
vi.mock("@/lib/users", () => ({
  getUserTimezone: mocks.getUserTimezone,
  getUserLanguage: mocks.getUserLanguage,
}));
vi.mock("@/lib/website-sources", () => ({
  getWebsiteSource: mocks.getWebsiteSource,
}));

const WorkerDetailPage = (await import("@/app/dashboard/workers/[id]/page"))
  .default;
const { t } = await import("@/lib/i18n");
const { generateMetadata } = await import("@/app/dashboard/workers/[id]/page");

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

/** Every `href` in the returned tree, string or object form. */
function hrefs(node: ReactNode): unknown[] {
  const found: unknown[] = [];

  const walk = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const child of current) walk(child);
      return;
    }

    if (!current || typeof current !== "object") {
      return;
    }

    const props = (current as { props?: Record<string, unknown> }).props;
    if (!props) return;

    if ("href" in props) found.push(props.href);

    for (const value of Object.values(props)) walk(value);
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

function render(query: Record<string, string | string[] | undefined> = {}) {
  return WorkerDetailPage({
    params: Promise.resolve({ id: "worker-1" }),
    searchParams: Promise.resolve(query),
  });
}

/** One page of runs, as the read layer hands it over. */
const runPage = (
  runs: unknown[] = [],
  nextCursor: { startedAt: Date; id: string } | null = null,
) => ({ runs, nextCursor });

beforeEach(() => {
  mocks.requireUserId.mockReset().mockResolvedValue("user-1");
  mocks.getUserTimezone.mockReset().mockResolvedValue("UTC");
  // English by default, so the assertions below stay about which rows a
  // worker has rather than about what they are called.
  mocks.getUserLanguage.mockReset().mockResolvedValue("en");
  // The page reads one summary, not a list of runs: what it shows about
  // history is four numbers the database counted.
  mocks.summarizeRunsForWorker.mockReset().mockResolvedValue({
    totalRuns: 0,
    totalFailures: 0,
    lastResult: null,
    lastRunAt: null,
  });
  // The page also lists the newest few of those runs, so there is a way from a
  // worker to one of its executions once the dashboard's activity list has
  // moved past it.
  mocks.listRunsForWorkerPage.mockReset().mockResolvedValue(runPage());
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

/**
 * The same page, in Japanese.
 *
 * **What a worker *is* survives the translation and what it *says* does not.**
 * The rows are named in Japanese; the name, the instructions and the address
 * are the owner's material and come through exactly as stored — and which rows
 * exist at all is decided by the worker's kind, which no language touches.
 */
describe("worker detail in Japanese", () => {
  beforeEach(() => {
    mocks.getUserLanguage.mockResolvedValue("ja");
  });

  it("names a prompt worker's type in Japanese", async () => {
    expect(labelled(await render())["Worker の種類"]).toBe("プロンプト");
  });

  it("names a website worker's type in Japanese", async () => {
    mocks.getRoutineWithStoredKind.mockResolvedValue({
      routine: worker({ kind: "website" }),
      kind: "website",
    });
    mocks.getWebsiteSource.mockResolvedValue(SOURCE);

    expect(labelled(await render())["Worker の種類"]).toBe("Web ページ監視");
  });

  it("says so, rather than guessing, for a kind it cannot read", async () => {
    mocks.getRoutineWithStoredKind.mockResolvedValue({
      routine: worker(),
      kind: null,
    });

    expect(labelled(await render())["Worker の種類"]).toBe("不明");
  });

  it("labels the rest of the rows in Japanese", async () => {
    const rows = labelled(await render());

    expect(rows).toHaveProperty("実行頻度");
    expect(rows).toHaveProperty("次回実行");
    expect(rows).toHaveProperty("前回の実行");
    expect(rows).toHaveProperty("作成日時");
    expect(rows).toHaveProperty("更新日時");
    expect(rows).not.toHaveProperty("Frequency");
  });

  it("writes the timestamps exactly as the English page does", async () => {
    mocks.getUserLanguage.mockResolvedValue("en");
    const english = labelled(await render())["Created At"];

    mocks.getUserLanguage.mockResolvedValue("ja");
    const japanese = labelled(await render())["作成日時"];

    expect(japanese).toBe(english);
  });

  it("leaves a website worker's page and instructions untouched", async () => {
    mocks.getRoutineWithStoredKind.mockResolvedValue({
      routine: worker({ kind: "website", prompt: "Tell me what changed." }),
      kind: "website",
    });
    mocks.getWebsiteSource.mockResolvedValue(SOURCE);

    const shown = text(await render());

    expect(shown).toContain("監視中のページ");
    expect(shown).toContain("変更時の指示");
    expect(shown).toContain("https://example.com/news");
    expect(shown).toContain("Tell me what changed.");
  });

  it("shows no page for a prompt worker, in either language", async () => {
    const shown = text(await render());

    expect(shown).not.toContain("監視中のページ");
    expect(shown).not.toContain("変更時の指示");
    expect(shown).not.toContain("Watched page");
  });
});

/**
 * The way from a worker to one of its executions.
 *
 * **The route this restores.** Bounding the dashboard's activity list to the
 * newest twenty rows left every older run recorded and unreachable: the row was
 * still there, and no screen carried its id. A worker's own history is where
 * that id lives now, which is what makes the reason a run failed — shown on the
 * execution's own page — findable again.
 */
describe("worker detail — its own run history", () => {
  const run = (overrides: Record<string, unknown> = {}) => ({
    id: "run-1",
    status: "completed" as const,
    startedAt: NOW,
    ...overrides,
  });

  it("reads the worker's runs as this account", async () => {
    await render();

    expect(mocks.listRunsForWorkerPage).toHaveBeenCalledWith(
      "worker-1",
      "user-1",
      null,
    );
  });

  it("gives the section a heading of its own", async () => {
    expect(text(await render())).toContain("Run History");
  });

  /**
   * The order comes from the query, and the page passes it through — a list
   * re-sorted here would be a second opinion about which run is newest.
   */
  it("keeps the order it was given", async () => {
    const newest = run({ id: "newest" });
    const older = run({ id: "older" });
    mocks.listRunsForWorkerPage.mockResolvedValue(runPage([newest, older]));

    const passed = passedRuns(await render());

    expect(passed).toEqual([newest, older]);
  });

  /** Whatever the helper returns is what is shown; the bound is in the query. */
  it("hands the list over without trimming it", async () => {
    const runs = Array.from({ length: 20 }, (_, index) =>
      run({ id: `run-${index}` }),
    );
    mocks.listRunsForWorkerPage.mockResolvedValue(runPage(runs));

    expect(passedRuns(await render())).toBe(runs);
  });

  it("names the section in Japanese", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");

    const shown = text(await render());

    expect(shown).toContain("実行履歴");
    expect(shown).not.toContain("Run History");
  });

  /** The list is told which language to draw itself in. */
  it("hands the list the account's language and zone", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");
    mocks.getUserTimezone.mockResolvedValue("Asia/Tokyo");
    mocks.listRunsForWorkerPage.mockResolvedValue(runPage([run()]));

    const section = sectionProps(await render());

    expect(section.language).toBe("ja");
    expect(section.timezone).toBe("Asia/Tokyo");
  });

  /**
   * What a run produced, and the reason a failed one gives, are the execution
   * page's to show. Reading them for a list that shows neither would be paying
   * for both.
   */
  it("never asks for the output or the diagnostic", async () => {
    mocks.listRunsForWorkerPage.mockResolvedValue(
      runPage([run({ status: "failed" })]),
    );

    const passed = passedRuns(await render()) as Record<string, unknown>[];

    expect(Object.keys(passed[0]).sort()).toEqual([
      "id",
      "startedAt",
      "status",
    ]);
  });
});

/** The list handed to the run history section. */
function passedRuns(node: ReactNode): unknown {
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

    if ("runs" in props) {
      found = props.runs;
      return;
    }

    for (const value of Object.values(props)) {
      walk(value);
    }
  };

  walk(node);
  return found;
}

/** Every prop given to the component that was handed the run list. */
function sectionProps(node: ReactNode): Record<string, unknown> {
  let found: Record<string, unknown> = {};

  const walk = (current: unknown): void => {
    if (Object.keys(found).length > 0) {
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

    if ("runs" in props) {
      found = props;
      return;
    }

    for (const value of Object.values(props)) {
      walk(value);
    }
  };

  walk(node);
  return found;
}

/**
 * What a browser tab and a search result say this screen is.
 *
 * **The document declares a language and the title has to be in it.** The root
 * layout writes the account's language onto `<html>`; a title left in English
 * under `lang="ja"` is the one part of the page contradicting the attribute a
 * screen reader chooses its voice from.
 *
 * **The resolver is replaced, not re-tested.** Which language a request is in
 * is settled in `lib/i18n/server.test.ts`. What is checked here is the mapping
 * from a language to two strings — including that the English wording is
 * exactly what it has always been, because a correctness fix must not quietly
 * reword the product.
 */
describe("what the tab says", () => {
  it("keeps the English title and description exactly as they were", async () => {
    metadataMocks.getDocumentLanguage.mockResolvedValue("en");

    await expect(generateMetadata()).resolves.toMatchObject({
      title: "Worker — Koqentra",
      description: "A worker and its schedule.",
    });
  });

  it("says the same thing in Japanese when the account reads Japanese", async () => {
    metadataMocks.getDocumentLanguage.mockResolvedValue("ja");

    await expect(generateMetadata()).resolves.toMatchObject({
      title: "Worker — Koqentra",
      description: "Worker とそのスケジュールの詳細です。",
    });
  });

  /** The product name is a name in both languages. */
  it("leaves the name untranslated in either language", async () => {
    for (const language of ["en", "ja"] as const) {
      metadataMocks.getDocumentLanguage.mockResolvedValue(language);

      expect((await generateMetadata()).title).toContain("Koqentra");
    }
  });

  /**
   * **Generic on purpose.** Nothing about the record is read to build this: a
   * title carrying a worker's name or a run's id would put an owned row into
   * the one part of the document that is read before anything checks who is
   * asking.
   */
  it("names no record, in either language", async () => {
    for (const language of ["en", "ja"] as const) {
      metadataMocks.getDocumentLanguage.mockResolvedValue(language);

      const { title } = await generateMetadata();

      expect(title).not.toMatch(/[0-9a-f]{8}/i);
    }
  });
});

/**
 * Getting to a run older than the twenty this page shows.
 *
 * **The rows were always there; the route was not.** The list has always been
 * bounded to twenty, which is what keeps the query small — but nothing named
 * the twenty-first, so a worker that had run twenty-one times had an execution
 * recorded and unreachable. Production had a worker sitting exactly on that
 * boundary, so the next scheduled run would have made it real.
 *
 * **A position in the URL, not a page number.** The list grows at the top while
 * somebody reads it; counting rows from the newest would shift under them.
 */
describe("reaching older runs", () => {
  const AT = new Date("2026-08-10T12:00:00.000Z");
  const run = () => ({ id: "run-1", status: "completed" as const, startedAt: AT });
  const OLDER = "Older runs";
  const LATEST = "Back to latest";

  it("reads the newest page when the address says nothing", async () => {
    await render();

    expect(mocks.listRunsForWorkerPage).toHaveBeenCalledWith(
      "worker-1",
      "user-1",
      null,
    );
  });

  it("continues from the position the address names", async () => {
    await render({ runBefore: AT.toISOString(), runBeforeId: "run-019" });

    expect(mocks.listRunsForWorkerPage).toHaveBeenCalledWith(
      "worker-1",
      "user-1",
      { startedAt: AT, id: "run-019" },
    );
  });

  /**
   * **Both halves or neither.** The pair names a position in an ordering whose
   * tie-break is the id, so half of it is not a position. A broken link is a
   * broken link — the newest page is the honest answer, not a 404.
   */
  it.each([
    ["only a timestamp", { runBefore: AT.toISOString() }],
    ["only an id", { runBeforeId: "run-019" }],
    ["a timestamp that is not a date", { runBefore: "yesterday", runBeforeId: "run-019" }],
    ["a blank id", { runBefore: AT.toISOString(), runBeforeId: "   " }],
    ["something else entirely", { page: "2" }],
  ])("falls back to the newest page given %s", async (_name, query) => {
    await render(query);

    expect(mocks.listRunsForWorkerPage).toHaveBeenCalledWith(
      "worker-1",
      "user-1",
      null,
    );
  });

  it("offers a way further back when there is more", async () => {
    mocks.listRunsForWorkerPage.mockResolvedValue(
      runPage([run()], { startedAt: AT, id: "run-019" }),
    );

    expect(text(await render())).toContain(OLDER);
  });

  it("offers none when the history ends here", async () => {
    mocks.listRunsForWorkerPage.mockResolvedValue(runPage([run()]));

    const html = await render();

    expect(text(html)).not.toContain(OLDER);
    expect(text(html)).not.toContain(LATEST);
  });

  it("offers the way back only once the reader has gone somewhere", async () => {
    mocks.listRunsForWorkerPage.mockResolvedValue(runPage([run()]));

    expect(
      text(await render({ runBefore: AT.toISOString(), runBeforeId: "run-019" })),
    ).toContain(LATEST);
  });

  /** A middle page has somewhere to go in both directions. */
  it("offers both on a page with older runs behind it", async () => {
    mocks.listRunsForWorkerPage.mockResolvedValue(
      runPage([run()], { startedAt: AT, id: "run-039" }),
    );

    const shown = text(
      await render({ runBefore: AT.toISOString(), runBeforeId: "run-019" }),
    );

    expect(shown).toContain(LATEST);
    expect(shown).toContain(OLDER);
  });

  /**
   * **Handed over as a query object, so the framework escapes it.** An ISO
   * timestamp carries colons; a hand-built string would put them in a URL
   * unencoded. Asserting the structure is what fixes that the encoding is
   * never ours to get wrong.
   */
  it("carries the position as a query for the framework to encode", async () => {
    mocks.listRunsForWorkerPage.mockResolvedValue(
      runPage([run()], { startedAt: AT, id: "run-019" }),
    );

    expect(hrefs(await render())).toContainEqual({
      pathname: "/dashboard/workers/worker-1",
      query: {
        runBefore: "2026-08-10T12:00:00.000Z",
        runBeforeId: "run-019",
      },
    });
  });

  it("keeps this worker's id in the address it offers", async () => {
    mocks.listRunsForWorkerPage.mockResolvedValue(
      runPage([run()], { startedAt: AT, id: "run-019" }),
    );

    const offered = hrefs(await render()).filter(
      (href): href is { pathname: string } =>
        typeof href === "object" && href !== null && "pathname" in href,
    );

    for (const href of offered) {
      expect(href.pathname).toBe("/dashboard/workers/worker-1");
    }
  });

  it("sends the way back to this worker with nothing appended", async () => {
    mocks.listRunsForWorkerPage.mockResolvedValue(runPage([run()]));

    const found = hrefs(
      await render({ runBefore: AT.toISOString(), runBeforeId: "run-019" }),
    );

    expect(found).toContain("/dashboard/workers/worker-1");
  });

  it.each(["en", "ja"] as const)("names both ways in %s", async (language) => {
    mocks.getUserLanguage.mockResolvedValue(language);
    mocks.listRunsForWorkerPage.mockResolvedValue(
      runPage([run()], { startedAt: AT, id: "run-039" }),
    );

    const shown = text(
      await render({ runBefore: AT.toISOString(), runBeforeId: "run-019" }),
    );

    expect(shown).toContain(t(language, "worker.detail.olderRuns"));
    expect(shown).toContain(t(language, "worker.detail.backToLatestRuns"));
  });
});
