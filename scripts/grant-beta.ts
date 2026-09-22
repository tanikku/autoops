import { grantBetaSubscription } from "@/lib/billing/admin";
import { prisma } from "@/lib/prisma";
import {
  GrantBetaCliError,
  parseGrantBetaArgs,
  runGrantBeta,
  type GrantBetaDeps,
} from "./grant-beta-runner";

/**
 * The command an operator actually runs.
 *
 * ```
 * railway run pnpm exec tsx --conditions=react-server scripts/grant-beta.ts \
 *   --expected-users=5 \
 *   --expires-at=2026-12-31T23:59:59Z
 * ```
 *
 * **Nothing is written without `--execute`.** The command above reads, judges
 * the whole cohort and reports; adding `--execute` is the only thing that turns
 * it into a write.
 *
 * **`--conditions=react-server` is not optional.** `lib/billing/admin.ts` and
 * `lib/prisma.ts` both carry `import "server-only"`, whose package resolves to
 * an empty module under that condition and to a throwing one without it.
 * Leaving the flag off fails loudly at import, before a connection exists,
 * which is the right way for it to fail.
 *
 * **This file holds the wiring and nothing else.** What the command means lives
 * in `grant-beta-runner.ts`, where it can be tested without a database; what a
 * grant *is* lives in `grantBetaSubscription`, which is the only thing here
 * that writes.
 */

/** The cohort: every account that exists, with what it already has. */
const deps: GrantBetaDeps = {
  async readCohort() {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        subscription: {
          select: { plan: true, state: true, source: true, expiresAt: true },
        },
        _count: { select: { routines: { where: { status: "active" } } } },
      },
    });

    return users.map((user) => ({
      userId: user.id,
      subscription: user.subscription,
      activeWorkers: user._count.routines,
    }));
  },

  async readUsageBaseline() {
    const [usagePeriods, usageCounters, providerUsageEvents] =
      await Promise.all([
        prisma.usagePeriod.count(),
        prisma.usageCounter.count(),
        prisma.providerUsageEvent.count(),
      ]);

    return { usagePeriods, usageCounters, providerUsageEvents };
  },

  grant: grantBetaSubscription,
};

async function main(): Promise<number> {
  let options;

  try {
    options = parseGrantBetaArgs(process.argv.slice(2), new Date());
  } catch (error) {
    if (error instanceof GrantBetaCliError) {
      console.error(error.message);
      return 1;
    }

    throw error;
  }

  const report = await runGrantBeta(options, deps);

  for (const line of report.lines) {
    console.log(line);
  }

  return report.ok ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // **The category, not the record.** A driver's own complaint names tables
    // and connection strings; an operator can act on neither, and a transcript
    // outlives the command that produced it.
    console.error(
      "RESULT: FAILED —",
      error instanceof Error ? error.name : "an unexpected failure",
    );
    process.exitCode = 1;
  })
  .finally(() => {
    // A CLI has to let the process end. The web runtime keeps its client for
    // the lifetime of the server and is untouched by this.
    void prisma.$disconnect();
  });
