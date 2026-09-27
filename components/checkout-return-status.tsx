"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { readCheckoutReturnStatusAction } from "@/app/dashboard/billing/return/actions";
import type { CheckoutReturnStatus } from "@/lib/billing/checkout-return";
import { Button } from "@/components/ui/button";

/**
 * Waiting for a purchase to appear, and saying so honestly while it does not.
 *
 * **Why anything waits at all.** The provider redirects the moment a card
 * clears; Koqentra's entitlement is written afterwards, by a reconciliation run
 * that a cron tick starts. Production measured 52 seconds for that, on a
 * five-minute cadence — so this page exists to hold the gap rather than report
 * what the row said during it.
 *
 * **It never says a purchase succeeded until a bought plan is active.** Arriving
 * here means the provider sent somebody back, which is not the same claim. The
 * only success copy is behind `status === "active"`.
 *
 * **Running out of time is not a failure.** The budget below covers the worst
 * cadence with room to spare, and if the answer still has not changed the copy
 * says it is still being confirmed and points at the plans page. It does not say
 * the payment failed, and it offers nothing to buy: a second purchase is exactly
 * what somebody in this position must not be nudged into.
 *
 * **The words arrive translated**, as `DashboardNavLinks` and
 * `CheckoutPlanButton` take theirs — handing over a language would pull both
 * dictionaries into this page's bundle.
 *
 * **The schedule is a pure function, and that is deliberate**: this project's
 * tests have no DOM, so a cadence that lived inside an effect could not be
 * checked at all. `nextPollDelayMs` and `shouldKeepPolling` are the whole of the
 * behaviour.
 */

/** When the answer stops being worth asking for again. */
export const POLL_BUDGET_MS = 330_000;

/** How long the fast phase lasts, and the two intervals. */
export const POLL_FAST_PHASE_MS = 30_000;
export const POLL_FAST_INTERVAL_MS = 2_000;
export const POLL_SLOW_INTERVAL_MS = 5_000;

/**
 * How long to wait before asking again.
 *
 * **Two rates, because the two halves of the wait are different.** Most
 * purchases land inside the first half-minute, and somebody watching a screen
 * notices a two-second answer; after that the wait is bounded by a five-minute
 * cron cadence, and asking 150 more times would be a browser hammering a server
 * action to learn nothing. No jitter: there is one client per purchase, so there
 * is no herd to spread out, and a deterministic schedule is one a test can state.
 */
export function nextPollDelayMs(elapsedMs: number): number {
  return elapsedMs < POLL_FAST_PHASE_MS
    ? POLL_FAST_INTERVAL_MS
    : POLL_SLOW_INTERVAL_MS;
}

/**
 * Whether to ask again.
 *
 * **`unavailable` keeps trying.** It means a query did not answer, which is the
 * kind of thing that stops being true; `active` and `not-entitled` are settled
 * and asking again would only be asking whether the database changed its mind.
 */
export function shouldKeepPolling(
  status: CheckoutReturnStatus | null,
  elapsedMs: number,
): boolean {
  if (elapsedMs >= POLL_BUDGET_MS) {
    return false;
  }

  return (
    status === null || status.status === "pending" || status.status === "unavailable"
  );
}

/** Which of the four things the page is showing. */
export type ReturnView = "pending" | "active" | "not-entitled" | "timed-out";

/**
 * What to show for an answer, and for having run out of time.
 *
 * **A budget that ran out while the answer was still `pending` is its own
 * view**, because the copy has to change: waiting says "a moment", giving up says
 * "check again shortly". A settled answer is shown as itself however long it took.
 */
export function viewFor(
  status: CheckoutReturnStatus | null,
  exhausted: boolean,
): ReturnView {
  if (status !== null && status.status === "active") {
    return "active";
  }

  if (status !== null && status.status === "not-entitled") {
    return "not-entitled";
  }

  return exhausted ? "timed-out" : "pending";
}

/** Every word this component may show, already in the right language. */
export type CheckoutReturnLabels = {
  readonly pendingHeading: string;
  readonly pendingBody: string;
  readonly pendingPatience: string;
  /** `{plan}` is filled with the plan's own name. */
  readonly activeHeading: string;
  readonly activeBody: string;
  readonly notEntitledHeading: string;
  readonly notEntitledBody: string;
  readonly timedOutHeading: string;
  readonly timedOutBody: string;
  readonly goToPlans: string;
  /** The plan names, so a filled sentence never shows a stored id. */
  readonly planNames: Readonly<Record<string, string>>;
};

/** Fills `{plan}` the way `lib/i18n` would, without importing its dictionaries. */
function fillPlan(template: string, plan: string): string {
  return template.replace(/\{plan\}/g, plan);
}

export function CheckoutReturnStatusPanel({
  labels,
}: {
  readonly labels: CheckoutReturnLabels;
}) {
  const [status, setStatus] = useState<CheckoutReturnStatus | null>(null);
  const [exhausted, setExhausted] = useState(false);
  useEffect(() => {
    // **Taken here rather than at render.** The effect runs once, so this is the
    // instant the wait began — and a re-render caused by an answer cannot restart
    // the clock the budget is measured against.
    const begunAt = Date.now();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const ask = async () => {
      let answer: CheckoutReturnStatus;

      try {
        answer = await readCheckoutReturnStatusAction();
      } catch {
        // A call that did not complete is the same to a reader as one that could
        // not answer: keep waiting, say nothing about why.
        answer = { status: "unavailable" };
      }

      if (cancelled) {
        return;
      }

      setStatus(answer);

      const elapsed = Date.now() - begunAt;

      if (!shouldKeepPolling(answer, elapsed)) {
        if (answer.status !== "active" && answer.status !== "not-entitled") {
          setExhausted(true);
        }

        return;
      }

      // One timer at a time, always the one this run scheduled: the next ask is
      // only ever queued after the previous one answered.
      timer = setTimeout(() => void ask(), nextPollDelayMs(elapsed));
    };

    void ask();

    return () => {
      cancelled = true;

      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, []);

  const view = viewFor(status, exhausted);
  const planName =
    status !== null && status.status === "active"
      ? (labels.planNames[status.plan] ?? "")
      : "";

  return (
    <section className="mt-10 border-t border-border pt-8">
      {view === "pending" ? (
        <>
          <h2 className="text-lg font-medium tracking-tight">
            {labels.pendingHeading}
          </h2>
          <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
            {labels.pendingBody}
          </p>
          <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
            {labels.pendingPatience}
          </p>
        </>
      ) : null}

      {view === "active" ? (
        <>
          <h2 className="text-lg font-medium tracking-tight">
            {fillPlan(labels.activeHeading, planName)}
          </h2>
          <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
            {labels.activeBody}
          </p>
        </>
      ) : null}

      {view === "not-entitled" ? (
        <>
          <h2 className="text-lg font-medium tracking-tight">
            {labels.notEntitledHeading}
          </h2>
          <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
            {labels.notEntitledBody}
          </p>
        </>
      ) : null}

      {view === "timed-out" ? (
        <>
          <h2 className="text-lg font-medium tracking-tight">
            {labels.timedOutHeading}
          </h2>
          <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
            {labels.timedOutBody}
          </p>
        </>
      ) : null}

      {/* **A way onwards, and never a way to buy again.** The one control on this
          page goes to the plans screen, which says precisely what the account is
          on. Nothing here offers a purchase. */}
      <div className="mt-5">
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<Link href="/dashboard/billing" />}
        >
          {labels.goToPlans}
        </Button>
      </div>
    </section>
  );
}
