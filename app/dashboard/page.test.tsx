import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";

/**
 * The screen signing in lands on.
 *
 * **What is fixed here is mostly what it is not.** `/dashboard` used to be the
 * workers list, and the product opened on Creator — so somebody arrived mid-task
 * on a screen full of controls. This page lists no worker, edits nothing, sells
 * nothing and starts nothing; several tests below assert those absences, which is
 * the point of the separation.
 *
 * **The plan it names has to be a plan the account has.** An ended subscription
 * leaves its plan in the row, and naming that would be the defect the plans page
 * was fixed for — twice over here, because this is the first screen somebody sees.
 */

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  getUsageSnapshot: vi.fn(),
  readPricingView: vi.fn(),
  listRecentRuns: vi.fn(),
  getUserTimezone: vi.fn(),
  getUserLanguage: vi.fn(),
  getDocumentLanguage: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireUserId: mocks.requireUserId }));
vi.mock("@/lib/usage/snapshot", () => ({
  getUsageSnapshot: mocks.getUsageSnapshot,
}));
vi.mock("@/lib/billing/pricing", () => ({
  readPricingView: mocks.readPricingView,
}));
vi.mock("@/lib/runs", () => ({ listRecentRuns: mocks.listRecentRuns }));
vi.mock("@/lib/users", () => ({
  getUserTimezone: mocks.getUserTimezone,
  getUserLanguage: mocks.getUserLanguage,
}));
vi.mock("@/lib/i18n/server", () => ({
  getDocumentLanguage: mocks.getDocumentLanguage,
}));
vi.mock("@/components/dashboard-nav", () => ({ DashboardNav: () => null }));

const HomePage = (await import("@/app/dashboard/page")).default;
const { generateMetadata } = await import("@/app/dashboard/page");

const USER = "116614511017733764020";
const EMAIL = "someone@example.invalid";

/** What the usage snapshot says about an account that has done a little. */
function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    periodStart: new Date("2026-09-01T00:00:00.000Z"),
    periodEnd: new Date("2026-10-01T00:00:00.000Z"),
    planBaseline: "lite",
    partialPeriod: false,
    counters: [
      { kind: "aiProcessing", used: 12, limit: 30, percent: 40, status: "normal" },
      { kind: "manualRun", used: 3, limit: 20, percent: 15, status: "normal" },
    ],
    activeWorkers: 1,
    activeWorkerLimit: 2,
    ...overrides,
  };
}

/** What the pricing read model says about a bought plan in force. */
function current(overrides: Record<string, unknown> = {}) {
  return {
    kind: "on-plan",
    plan: "lite",
    state: "active",
    purchased: true,
    entitled: true,
    ...overrides,
  };
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    status: "success",
    startedAt: new Date("2026-09-27T06:00:00.000Z"),
    output: "",
    routineName: "Morning digest",
    routineKind: "prompt",
    ...overrides,
  };
}

const render = async () => renderToStaticMarkup(await HomePage());

beforeEach(() => {
  mocks.requireUserId.mockReset().mockResolvedValue(USER);
  mocks.getUsageSnapshot.mockReset().mockResolvedValue(snapshot());
  mocks.readPricingView
    .mockReset()
    .mockResolvedValue({ current: current(), activeWorkers: 1, plans: [] });
  mocks.listRecentRuns.mockReset().mockResolvedValue([]);
  mocks.getUserTimezone.mockReset().mockResolvedValue("Asia/Tokyo");
  mocks.getUserLanguage.mockReset().mockResolvedValue("en");
  mocks.getDocumentLanguage.mockReset().mockResolvedValue("en");
});

describe("what the home screen is", () => {
  it("greets the reader and says what the screen is for", async () => {
    const html = await render();

    expect(html).toContain(t("en", "dashboard.home.welcome"));
    expect(html).toContain(t("en", "dashboard.home.subtitle"));
  });

  it("is titled as the home screen", async () => {
    expect((await generateMetadata()).title).toBe("Home — Koqentra");
  });

  it("is titled in the language the page is in", async () => {
    mocks.getDocumentLanguage.mockResolvedValue("ja");

    expect((await generateMetadata()).title).toBe("ホーム — Koqentra");
  });

  it("speaks the account's language", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");

    const html = await render();

    expect(html).toContain(t("ja", "dashboard.home.welcome"));
    expect(html).toContain(t("ja", "dashboard.home.subtitle"));
  });

  it("authenticates without provisioning a row", async () => {
    await render();

    expect(mocks.requireUserId).toHaveBeenCalledTimes(1);
  });

  /** A server component: there is no selection to hold and no form to submit. */
  it("is not a client component", async () => {
    const { readFileSync } = await import("node:fs");

    expect(readFileSync("app/dashboard/page.tsx", "utf8")).not.toContain(
      '"use client"',
    );
  });
});

/**
 * **It is not the workers list any more.** That screen moved to its own route;
 * leaving any of it here would be two places showing the same thing.
 */
describe("what the home screen is not", () => {
  it("lists no worker", async () => {
    const html = await render();

    expect(html).not.toContain(t("en", "dashboard.workers"));
    expect(html).not.toContain(t("en", "dashboard.hireFirstWorker"));
    expect(html).not.toContain("Morning digest");
  });

  it("offers no worker controls", async () => {
    const html = await render();

    for (const forbidden of ["Run", "Pause", "Delete", "Edit"]) {
      expect(html, `offers ${forbidden}`).not.toContain(`>${forbidden}<`);
    }
  });

  it("holds no Creator editor and no analysis form", async () => {
    const html = await render();

    expect(html).not.toContain("<form");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain('type="checkbox"');
  });

  it("sells nothing", async () => {
    const html = await render();

    expect(html).not.toContain("780");
    expect(html).not.toContain("Choose Lite");
    expect(html).not.toContain(t("en", "pricing.cta.comingSoon"));
  });

  it("imports nothing that could write", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("app/dashboard/page.tsx", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of [
      "prisma",
      "requireProvisionedUserId",
      "startCheckout",
      "openOrGetUsagePeriod",
      "consumeUsage",
      "recordAIExecution",
      "new Stripe",
      "fetch(",
      "revalidatePath",
      "redirect(",
    ]) {
      expect(source, `uses ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("the two things it offers to do", () => {
  it("opens Creator", async () => {
    const html = await render();

    expect(html).toContain('href="/creator"');
    expect(html).toContain(t("en", "dashboard.home.openCreator"));
  });

  it("creates a Worker through the existing route", async () => {
    const html = await render();

    expect(html).toContain('href="/dashboard/new"');
    expect(html).toContain(t("en", "dashboard.home.createWorker"));
  });

  it("offers nothing else", async () => {
    const html = await render();
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);

    expect(hrefs).toEqual(["/creator", "/dashboard/new"]);
  });

  it("says both in Japanese", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");

    const html = await render();

    expect(html).toContain(t("ja", "dashboard.home.openCreator"));
    expect(html).toContain(t("ja", "dashboard.home.createWorker"));
  });
});

describe("the three numbers", () => {
  it("counts the account's active workers against its allowance", async () => {
    const html = await render();

    expect(html).toContain(t("en", "dashboard.home.activeWorkers"));
    expect(html).toContain("1 / 2");
  });

  it("reads them from the usage snapshot for this account", async () => {
    await render();

    expect(mocks.getUsageSnapshot).toHaveBeenCalledWith(USER, expect.any(Date));
  });

  it("shows the AI runs counter against its limit", async () => {
    const html = await render();

    expect(html).toContain(t("en", "dashboard.home.aiRuns"));
    expect(html).toContain("12 / 30");
  });

  /**
   * **Zero, not nothing.** A month with no counters is an account that has done
   * nothing observable, not an account with no allowance — so the limit comes
   * from the plan the snapshot was compared against.
   */
  it("shows zero against the plan's allowance when nothing was counted", async () => {
    mocks.getUsageSnapshot.mockResolvedValue(
      snapshot({ counters: null, planBaseline: "lite" }),
    );

    expect(await render()).toContain("0 / 30");
  });

  it("uses the baseline plan's allowance, whichever it is", async () => {
    mocks.getUsageSnapshot.mockResolvedValue(
      snapshot({ counters: null, planBaseline: "standard" }),
    );

    expect(await render()).toContain("0 / 150");
  });

  /**
   * **It never says "this month".** The counters cover the account's current
   * usage period, which begins when the account first used something in it — so a
   * number presented as a monthly total would be wrong for every account whose
   * period started late. The caption says what it is measured over.
   */
  it.each([true, false])(
    "says what the number is measured over (partial: %s)",
    async (partialPeriod) => {
      mocks.getUsageSnapshot.mockResolvedValue(snapshot({ partialPeriod }));

      const html = await render();

      expect(html).toContain(t("en", "dashboard.home.currentUsagePeriod"));
      expect(html).not.toContain("this month");
    },
  );

  it("says the caption in Japanese too", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");

    expect(await render()).toContain(
      t("ja", "dashboard.home.currentUsagePeriod"),
    );
  });
});

/**
 * The plan.
 *
 * **Entitlement decides, not history.** This is the first screen somebody sees,
 * and telling them they are on a plan whose subscription has ended is the defect
 * the plans page was fixed for.
 */
describe("the plan it names", () => {
  it("reads it for this account", async () => {
    await render();

    expect(mocks.readPricingView).toHaveBeenCalledWith(USER);
  });

  it.each([
    ["lite", "Lite"],
    ["standard", "Standard"],
    ["pro", "Pro"],
  ])("names a bought %s as %s", async (plan, label) => {
    mocks.readPricingView.mockResolvedValue({
      current: current({ plan }),
      activeWorkers: 1,
      plans: [],
    });

    const html = await render();

    expect(html).toContain(t("en", "dashboard.home.currentPlan"));
    expect(html).toContain(label);
  });

  it("names the granted Closed Beta allowance", async () => {
    mocks.readPricingView.mockResolvedValue({
      current: current({ plan: "beta", purchased: false }),
      activeWorkers: 1,
      plans: [],
    });

    expect(await render()).toContain("Beta");
  });

  it("names a running trial", async () => {
    mocks.readPricingView.mockResolvedValue({
      current: current({ plan: "trial", state: "trialing", purchased: false }),
      activeWorkers: 1,
      plans: [],
    });

    expect(await render()).toContain("Trial");
  });

  /** The defect this guards: a plan that entitles nothing is not a plan. */
  it.each(["inactive", "expired", "trial_expired"])(
    "says no plan for a historical plan in %s",
    async (state) => {
      mocks.readPricingView.mockResolvedValue({
        current: current({ state, entitled: false }),
        activeWorkers: 1,
        plans: [],
      });

      const html = await render();

      expect(html).toContain(t("en", "dashboard.home.noPlan"));
      expect(html).not.toContain("Lite");
    },
  );

  it("says no plan when there is none", async () => {
    mocks.readPricingView.mockResolvedValue({
      current: { kind: "none" },
      activeWorkers: 0,
      plans: [],
    });

    expect(await render()).toContain(t("en", "dashboard.home.noPlan"));
  });

  it("says no plan for a row it cannot read", async () => {
    mocks.readPricingView.mockResolvedValue({
      current: { kind: "unreadable" },
      activeWorkers: 0,
      plans: [],
    });

    expect(await render()).toContain(t("en", "dashboard.home.noPlan"));
  });

  /** A stored id a newer version wrote is not a label to read off. */
  it("says no plan for a plan this build does not know", async () => {
    mocks.readPricingView.mockResolvedValue({
      current: current({ plan: "enterprise" }),
      activeWorkers: 1,
      plans: [],
    });

    const html = await render();

    expect(html).toContain(t("en", "dashboard.home.noPlan"));
    expect(html).not.toContain("enterprise");
  });

  it("never shows a stored plan id", async () => {
    const html = await render();

    expect(html).not.toMatch(/>lite</);
    expect(html).not.toMatch(/>beta</);
  });

  it("says no plan in Japanese", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");
    mocks.readPricingView.mockResolvedValue({
      current: { kind: "none" },
      activeWorkers: 0,
      plans: [],
    });

    expect(await render()).toContain(t("ja", "dashboard.home.noPlan"));
  });
});

describe("the last few runs", () => {
  it("asks for three and no more", async () => {
    await render();

    expect(mocks.listRecentRuns).toHaveBeenCalledWith(USER, 3);
  });

  it("shows what it was given, newest first", async () => {
    mocks.listRecentRuns.mockResolvedValue([
      run({ id: "run-3", routineName: "Newest" }),
      run({ id: "run-2", routineName: "Middle" }),
      run({ id: "run-1", routineName: "Oldest" }),
    ]);

    const html = await render();

    expect(html.indexOf("Newest")).toBeLessThan(html.indexOf("Middle"));
    expect(html.indexOf("Middle")).toBeLessThan(html.indexOf("Oldest"));
  });

  it("says so when there are none", async () => {
    const html = await render();

    expect(html).toContain(t("en", "dashboard.home.noRuns"));
  });

  it("says so in Japanese", async () => {
    mocks.getUserLanguage.mockResolvedValue("ja");

    expect(await render()).toContain(t("ja", "dashboard.home.noRuns"));
  });

  /** The empty line is this page's: "use Run on a worker" is advice elsewhere. */
  it("does not borrow the workers screen's empty line", async () => {
    expect(await render()).not.toContain(t("en", "dashboard.activityEmpty"));
  });

  it("does not list a whole history", async () => {
    mocks.listRecentRuns.mockResolvedValue([
      run({ id: "run-1", routineName: "One" }),
      run({ id: "run-2", routineName: "Two" }),
      run({ id: "run-3", routineName: "Three" }),
    ]);

    const html = await render();

    expect(html.match(/href="\/dashboard\/runs\//g) ?? []).toHaveLength(3);
  });
});

/**
 * A new account.
 *
 * Nothing bought, nothing run, no worker made: the page still has to read as a
 * home rather than as a broken one.
 */
describe("an account that has done nothing yet", () => {
  beforeEach(() => {
    // A trial's own allowances, as the catalogue states them.
    mocks.getUsageSnapshot.mockResolvedValue(
      snapshot({
        counters: null,
        activeWorkers: 0,
        activeWorkerLimit: 3,
        planBaseline: "trial",
      }),
    );
    mocks.readPricingView.mockResolvedValue({
      current: { kind: "none" },
      activeWorkers: 0,
      plans: [],
    });
    mocks.listRecentRuns.mockResolvedValue([]);
  });

  it("still renders every block", async () => {
    const html = await render();

    expect(html).toContain(t("en", "dashboard.home.welcome"));
    expect(html).toContain(t("en", "dashboard.home.overview"));
    expect(html).toContain(t("en", "dashboard.home.recentActivity"));
    expect(html).toContain(t("en", "dashboard.home.noRuns"));
    expect(html).toContain(t("en", "dashboard.home.noPlan"));
  });

  it("shows zero workers against the trial's allowance", async () => {
    const html = await render();

    expect(html).toContain("0 / 3");
    // The trial's AI allowance, taken from the baseline the snapshot names.
    expect(html).toContain("0 / 50");
  });

  it("leads with the two things there are to do", async () => {
    const html = await render();

    expect(html).toContain('href="/creator"');
    expect(html).toContain('href="/dashboard/new"');
  });
});

describe("what never reaches the page", () => {
  it("renders no account details", async () => {
    mocks.listRecentRuns.mockResolvedValue([run()]);

    const html = await render();

    expect(html).not.toContain(USER);
    expect(html).not.toContain(EMAIL);
    expect(html).not.toContain("@");
  });

  it("renders no provider or billing identifier", async () => {
    const html = (await render()).toLowerCase();

    for (const forbidden of [
      "price_",
      "cus_",
      "sub_",
      "cs_test",
      "sk_",
      "stripe",
      "attempt",
      "reconciliation",
      "checkout_sandbox_user_ids",
    ]) {
      expect(html, `renders ${forbidden}`).not.toContain(forbidden);
    }
  });

  /** A run's own id is a link target, not something written out as text. */
  it("writes no internal identifier as text", async () => {
    mocks.listRecentRuns.mockResolvedValue([run()]);

    const text = (await render()).replace(/<[^>]*>/g, " ");

    expect(text).not.toContain("run-1");
    expect(text).not.toContain(USER);
  });
});
