import type { Metadata } from "next";
import Link from "next/link";
import { DashboardNav } from "@/components/dashboard-nav";
import { RunHistoryList } from "@/components/run-history-list";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { planNameKey } from "@/lib/billing/plan-labels";
import { readPricingView } from "@/lib/billing/pricing";
import { t } from "@/lib/i18n";
import { getDocumentLanguage } from "@/lib/i18n/server";
import { getPlanDefinition } from "@/lib/plans";
import { listRecentRuns } from "@/lib/runs";
import { requireUserId } from "@/lib/session";
import { getUsageSnapshot } from "@/lib/usage/snapshot";
import { getUserLanguage, getUserTimezone } from "@/lib/users";

/**
 * Where signing in lands, and what it is for.
 *
 * **It exists because every other screen is a place to do one thing.** Creator
 * writes, Workers runs, Plans sells, Settings configures — and sign-in used to
 * drop somebody straight into the first of those, which made the product open
 * mid-task. This page answers "what is going on and what would I like to do
 * next", and nothing else.
 *
 * **Nothing here is a feature screen.** No worker is listed, edited, paused or
 * deleted; no plan is bought; no analysis is started. Three numbers, two links
 * and the last few runs — every one of which is a reading, and each of which has
 * a screen of its own to go to.
 *
 * **Read-only, and structurally so.** `requireUserId` authenticates without
 * provisioning, and the three helpers below are the same ones their own screens
 * use: `getUsageSnapshot` and `readPricingView` both document that they never
 * write, and `listRecentRuns` takes a limit. A home page that opened a usage
 * period to say what had been used would turn looking into using.
 *
 * **A server component, whole.** There is nothing to hold: no selection, no
 * form, no pending state. Keeping it here is also what keeps both translation
 * dictionaries out of this page's browser bundle.
 */
export async function generateMetadata(): Promise<Metadata> {
  const language = await getDocumentLanguage();

  return {
    title: `${t(language, "dashboard.home.title")} — Koqentra`,
    description: t(language, "dashboard.home.subtitle"),
  };
}

// Everything on it is read per request, so this page must not be prerendered.
export const dynamic = "force-dynamic";

/** Three: enough to show something moved, few enough not to be a list. */
const RECENT_RUNS_ON_HOME = 3;

/**
 * What to call the plan this account is on.
 *
 * **Entitlement decides, not history.** An account whose Lite subscription has
 * ended still has `lite` in its row, and naming it here would tell somebody they
 * are on a plan they no longer have — the same confusion the plans page was
 * fixed for. Only a plan that entitles something right now is named.
 *
 * **A plan this build cannot name falls back rather than guessing.** A stored id
 * a newer version wrote is not a label; saying "no plan" is wrong in a smaller
 * and more obvious way than showing `lite` to somebody.
 */
function currentPlanLabel(
  current: Awaited<ReturnType<typeof readPricingView>>["current"],
  language: string,
): string {
  if (current.kind !== "on-plan" || !current.entitled) {
    return t(language, "dashboard.home.noPlan");
  }

  const key = planNameKey(current.plan);

  return key === null
    ? t(language, "dashboard.home.noPlan")
    : t(language, key);
}

/** One number and what it is, as the three summary cards show it. */
function SummaryCard({
  label,
  value,
  caption,
}: {
  readonly label: string;
  readonly value: string;
  readonly caption?: string;
}) {
  return (
    <Card>
      <CardContent>
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
        {caption === undefined ? null : (
          <p className="mt-1 text-xs text-muted-foreground">{caption}</p>
        )}
      </CardContent>
    </Card>
  );
}

export default async function DashboardHomePage() {
  const userId = await requireUserId();
  // **One reading of the clock for the whole page**, so the usage period, the
  // runs and the stuck-run judgement cannot disagree about when "now" was.
  const now = new Date();

  const [usage, pricing, recentRuns, timezone, language] = await Promise.all([
    getUsageSnapshot(userId, now),
    readPricingView(userId),
    // Three, because this is a summary. The Workers screen has the rest.
    listRecentRuns(userId, RECENT_RUNS_ON_HOME),
    getUserTimezone(userId),
    getUserLanguage(userId),
  ]);

  // **The counter, or the allowance it would have been measured against.** A
  // month with no counters is an account that has done nothing observable, not
  // an account with no allowance — so the number is zero and the limit comes
  // from the plan the snapshot was compared against.
  const aiCounter = usage.counters?.find(
    (counter) => counter.kind === "aiProcessing",
  );
  const aiUsed = aiCounter?.used ?? 0;
  const aiLimit =
    aiCounter?.limit ?? getPlanDefinition(usage.planBaseline).aiProcessingLimit;

  return (
    <div className="flex flex-1 flex-col bg-background">
      <DashboardNav />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10 sm:px-10">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {t(language, "dashboard.home.welcome")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(language, "dashboard.home.subtitle")}
        </p>

        {/* **Two, and they are the two things somebody arrives wanting.** Every
            other destination is a click away in the bar above. */}
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Button
            className="w-full sm:w-auto"
            nativeButton={false}
            render={<Link href="/creator" />}
          >
            {t(language, "dashboard.home.openCreator")}
          </Button>
          <Button
            variant="outline"
            className="w-full sm:w-auto"
            nativeButton={false}
            render={<Link href="/dashboard/new" />}
          >
            {t(language, "dashboard.home.createWorker")}
          </Button>
        </div>

        <section className="mt-10">
          <h2 className="text-lg font-medium tracking-tight">
            {t(language, "dashboard.home.overview")}
          </h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <SummaryCard
              label={t(language, "dashboard.home.activeWorkers")}
              value={`${usage.activeWorkers} / ${usage.activeWorkerLimit}`}
            />
            {/* **"AI runs", never "AI runs this month".** The counters cover the
                account's current usage period, which begins when the account
                first used something in it — so a number presented as a monthly
                total would be one for every account whose period started late.
                The caption says what the number is measured over instead. */}
            <SummaryCard
              label={t(language, "dashboard.home.aiRuns")}
              value={`${aiUsed} / ${aiLimit}`}
              caption={t(language, "dashboard.home.currentUsagePeriod")}
            />
            <SummaryCard
              label={t(language, "dashboard.home.currentPlan")}
              value={currentPlanLabel(pricing.current, language)}
            />
          </div>
        </section>

        <section className="mt-10">
          <h2 className="text-lg font-medium tracking-tight">
            {t(language, "dashboard.home.recentActivity")}
          </h2>
          {/* **The Workers screen's own list, with three rows in it.** A second
              way of drawing a run would be a second thing to keep true about
              statuses, stuck runs and which sentences in an output are ours. The
              empty line is this page's, because "use Run on a worker" is advice
              for a screen that has the workers on it. */}
          {recentRuns.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">
              {t(language, "dashboard.home.noRuns")}
            </p>
          ) : (
            <RunHistoryList
              runs={recentRuns}
              timezone={timezone}
              language={language}
              now={now}
            />
          )}
        </section>
      </main>
    </div>
  );
}
