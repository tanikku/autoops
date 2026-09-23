import { TriangleAlert } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { t } from "@/lib/i18n";
import type { TrialUsageStatus, TrialUsageView } from "@/lib/usage/trial-view";

/**
 * What an account's trial has used, and how much of the fortnight is left.
 *
 * **Presentational, and deliberately without arithmetic.** Which period the
 * numbers come from, how close each is to its limit and how many days remain
 * are all decided in `getTrialUsageView`; this places them. A component that
 * worked any of it out again would be a second opinion that drifts the first
 * time one of them changes.
 *
 * **Every number reads `used / limit`, never as a remainder.** A trial can
 * legitimately begin past its AI limit, because what an account spent before
 * starting is carried in — and there is no honest way to write "47 remaining"
 * beside 63 of 50. One format that is always true beats two that are usually
 * shorter.
 *
 * **Nothing here refuses anything.** "Over the limit" is a description of a
 * number on a screen; the account runs exactly as it did yesterday. When
 * enforcement arrives it will be a change to what the app does, not to what
 * this says.
 */

/** The label for a status, or nothing when there is nothing to warn about. */
function statusLabel(status: TrialUsageStatus, language: string): string | null {
  switch (status) {
    case "normal":
      return null;
    case "approaching":
      return t(language, "trial.status.approaching");
    case "reached":
      return t(language, "trial.status.reached");
    case "over":
      return t(language, "trial.status.over");
  }
}

/**
 * One allowance: what it is, `used / limit`, and how that reads.
 *
 * **The numbers are not translated.** `3 / 50` is the same in every language,
 * and a dictionary entry for it would be a place for the two to disagree.
 */
function UsageRow({
  label,
  used,
  limit,
  status,
  language,
}: {
  label: string;
  used: number;
  limit: number;
  status: TrialUsageStatus;
  language: string;
}) {
  const warning = statusLabel(status, language);

  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="flex flex-wrap items-baseline justify-end gap-x-2 gap-y-1">
        <span className="text-sm font-semibold tabular-nums tracking-tight">
          {used} / {limit}
        </span>
        {warning ? (
          <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
            {warning}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** Which dictionary key names each allowance on screen. */
const USAGE_LABEL_KEYS = {
  aiProcessing: "trial.usage.aiProcessing",
  manualRun: "trial.usage.manualRun",
  discovery: "trial.usage.discovery",
} as const;

export function TrialUsageCard({
  view,
  language,
}: {
  view: TrialUsageView;
  /**
   * **The words, not the numbers.** Counts read the same everywhere, and the
   * card renders them as digits in both languages.
   */
  language: string;
}) {
  // An account on the granted beta allowance, or on a plan it bought, is not
  // on a trial and is told nothing about one.
  if (view.kind === "hidden" || view.kind === "pre-trial") {
    return null;
  }

  if (view.kind === "expired") {
    return (
      <Card>
        <CardContent>
          <p className="text-sm font-medium">
            {t(language, "trial.expired.title")}
          </p>
          {/* **The two fears, answered on the card.** Somebody whose free
              period has just ended wants to know whether their work is gone
              and whether they have been charged. Neither has happened.

              **And no upgrade button**, because there is nowhere to send
              anybody yet: a call to action leading nowhere is worse than
              none. */}
          <p className="mt-2 text-sm text-muted-foreground">
            {t(language, "trial.expired.retained")}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-sm font-medium">{t(language, "trial.title")}</p>
          <p className="text-sm text-muted-foreground tabular-nums">
            {t(language, "trial.daysRemaining", { days: view.daysRemaining })}
          </p>
        </div>

        <div className="mt-3 divide-y divide-border">
          {view.lines.map((line) => (
            <UsageRow
              key={line.kind}
              label={t(
                language,
                USAGE_LABEL_KEYS[line.kind as keyof typeof USAGE_LABEL_KEYS],
              )}
              used={line.used}
              limit={line.limit}
              status={line.status}
              language={language}
            />
          ))}
          {/* **Current state, not consumption**, which is why it is not one of
              the lines above: a period does not accumulate active workers, it
              has however many there are at the moment somebody looks. */}
          <UsageRow
            label={t(language, "trial.usage.activeWorkers")}
            used={view.activeWorkers}
            limit={view.activeWorkerLimit}
            status={view.activeWorkerStatus}
            language={language}
          />
        </div>

        {view.carriedInOverLimit ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {t(language, "trial.carriedIn")}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
