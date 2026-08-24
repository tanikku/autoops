import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Loader,
  TriangleAlert,
} from "lucide-react";
import { formatDateTime } from "@/lib/datetime";
import type { WorkerHealth } from "@/lib/health";
import { t, type TranslationKey } from "@/lib/i18n";
import type { RunStatus } from "@/types";

/**
 * How the last run reads here.
 *
 * **Deliberately its own words, not `common.runStatus.*`.** A run is
 * `Completed`; a worker whose last run completed is in `Success`. The two
 * screens have always said different things about the same value, and sharing
 * one set of keys would silently change one of them.
 */
const resultStyles: Record<
  RunStatus,
  { key: TranslationKey; className: string; Icon: typeof CircleCheck }
> = {
  completed: {
    key: "health.success",
    className: "text-emerald-600 dark:text-emerald-400",
    Icon: CircleCheck,
  },
  failed: {
    key: "health.failed",
    className: "text-destructive",
    Icon: CircleAlert,
  },
  running: {
    key: "health.running",
    className: "text-muted-foreground",
    Icon: Loader,
  },
};

const neverRun = {
  key: "health.neverRun" as TranslationKey,
  className: "text-muted-foreground",
  Icon: CircleDashed,
};

export function WorkerHealthSummary({
  health,
  timezone,
  language,
}: {
  health: WorkerHealth;
  timezone: string;
  language: string;
}) {
  const { key, className, Icon } = health.lastResult
    ? resultStyles[health.lastResult]
    : neverRun;

  return (
    <div className="flex flex-col gap-1 text-xs">
      <p className="font-medium text-muted-foreground">
        {t(language, "health.title")}
      </p>

      <p className={`flex items-center gap-1.5 ${className}`}>
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="font-medium">{t(language, key)}</span>
        {health.lastRunAt ? (
          <span className="text-muted-foreground">
            {formatDateTime(health.lastRunAt, timezone)}
          </span>
        ) : null}
      </p>

      {health.stuck ? (
        <p className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
          {t(language, "health.stuck")}
        </p>
      ) : null}

      {/* **The count sits inside the sentence rather than beside it.** English
          puts it first and inflects the noun after it; Japanese puts it in the
          middle and inflects nothing. Gluing a number to a word would write
          English word order into every language. */}
      <p className="text-muted-foreground">
        {t(
          language,
          health.totalRuns === 1 ? "health.runs.one" : "health.runs.other",
          { count: health.totalRuns },
        )}{" "}
        ·{" "}
        {t(
          language,
          health.totalFailures === 1
            ? "health.failures.one"
            : "health.failures.other",
          { count: health.totalFailures },
        )}
      </p>
    </div>
  );
}
