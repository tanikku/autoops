import {
  type ExistingGrant,
  type BetaGrantResult,
  isIdenticalBetaGrant,
} from "@/lib/billing/admin";
import { getPlanDefinition } from "@/lib/plans";

/**
 * Giving the carried-over accounts their beta entitlement, deliberately.
 *
 * **This is an operational tool with Production write capability**, and every
 * decision below follows from that one fact. It does nothing unless told to, it
 * checks the whole cohort before it writes a single row, and it prints numbers
 * rather than people.
 *
 * **Why a cohort rather than a list of accounts.** The set being granted is
 * "everybody who is already here", and naming them on a command line would mean
 * an operator typing identifiers that are also the key to every owned row. The
 * count guard replaces that: the command says how many accounts it expects, and
 * refuses if the number has moved. An account created between writing the
 * command and running it changes the count, and the run stops.
 *
 * **Why all validation happens first.** `grantBetaSubscription` writes one row
 * per account with no transaction spanning them, so a conflict discovered on
 * the fourth account after three were written would leave a half-granted
 * cohort. Finding every reason to stop before the first write is what makes
 * that impossible.
 *
 * **Nothing here writes to the database itself.** The tested helper is the one
 * write boundary; this decides whether to call it and how to report what
 * happened. See `GrantBetaDeps`.
 */

/** A refusal the operator can act on, raised before anything is read or written. */
export class GrantBetaCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantBetaCliError";
  }
}

export type GrantBetaOptions = {
  /** How many accounts the operator believes exist. A guard, not a selector. */
  readonly expectedUsers: number;
  readonly expiresAt: Date;
  /** False unless `--execute` was given. **The default writes nothing.** */
  readonly execute: boolean;
};

const EXPECTED_USERS_FLAG = "--expected-users=";
const EXPIRES_AT_FLAG = "--expires-at=";
const EXECUTE_FLAG = "--execute";

/**
 * Reads the command, or refuses it.
 *
 * **Every refusal happens here, before a connection is opened.** An operator
 * who mistyped an expiry should learn that from the command rather than from a
 * half-finished run, and a script that validated as it went would have to
 * decide what to do about the rows it had already written.
 *
 * **Unknown arguments are refused rather than ignored.** A misspelt
 * `--execute` that silently meant "dry run" would be the most dangerous
 * possible reading in one direction, and a misspelt guard the most dangerous in
 * the other.
 */
export function parseGrantBetaArgs(
  argv: readonly string[],
  now: Date,
): GrantBetaOptions {
  let expectedUsersRaw: string | null = null;
  let expiresAtRaw: string | null = null;
  let execute = false;

  for (const argument of argv) {
    if (argument === EXECUTE_FLAG) {
      execute = true;
      continue;
    }

    if (argument.startsWith(EXPECTED_USERS_FLAG)) {
      expectedUsersRaw = argument.slice(EXPECTED_USERS_FLAG.length);
      continue;
    }

    if (argument.startsWith(EXPIRES_AT_FLAG)) {
      expiresAtRaw = argument.slice(EXPIRES_AT_FLAG.length);
      continue;
    }

    throw new GrantBetaCliError(`Unknown argument: ${argument}`);
  }

  if (expectedUsersRaw === null) {
    throw new GrantBetaCliError(`Missing ${EXPECTED_USERS_FLAG}<count>`);
  }

  if (expiresAtRaw === null) {
    throw new GrantBetaCliError(`Missing ${EXPIRES_AT_FLAG}<ISO-8601>`);
  }

  // **Matched rather than coerced.** `Number("5x")` is `NaN` but `parseInt`
  // would read it as five, and a guard that accepted a typo would be no guard.
  if (!/^\d+$/.test(expectedUsersRaw)) {
    throw new GrantBetaCliError(
      `${EXPECTED_USERS_FLAG} must be a positive whole number`,
    );
  }

  const expectedUsers = Number(expectedUsersRaw);

  if (expectedUsers < 1) {
    throw new GrantBetaCliError(
      `${EXPECTED_USERS_FLAG} must be a positive whole number`,
    );
  }

  const expiresAt = new Date(expiresAtRaw);

  if (Number.isNaN(expiresAt.getTime())) {
    throw new GrantBetaCliError(`${EXPIRES_AT_FLAG} is not a usable timestamp`);
  }

  // **A grant that has already ended is not a grant.** Writing one would mean
  // five rows that entitle nobody, and the operator finding out only by reading
  // them back.
  if (expiresAt.getTime() <= now.getTime()) {
    throw new GrantBetaCliError(`${EXPIRES_AT_FLAG} must be in the future`);
  }

  return { expectedUsers, expiresAt, execute };
}

/** One account, as the cohort check needs to see it. */
export type CohortMember = {
  /**
   * The account the grant is for.
   *
   * **Never printed.** It is passed to the helper and nowhere else — see
   * `formatReport`, which has no access to it.
   */
  readonly userId: string;
  /** What the account already has, or null. */
  readonly subscription: ExistingGrant | null;
  readonly activeWorkers: number;
};

/** Aggregate counts, read so the operator can see they did not move. */
export type UsageBaseline = {
  readonly usagePeriods: number;
  readonly usageCounters: number;
  readonly providerUsageEvents: number;
};

/**
 * What the runner is allowed to do.
 *
 * **Deliberately three functions.** There is no `create`, no `update` and no
 * `delete` here beyond the one the helper owns: the runner cannot write a
 * `UsagePeriod`, reset a counter, or touch a worker even by mistake, because
 * nothing in this shape lets it.
 */
export type GrantBetaDeps = {
  readCohort(): Promise<readonly CohortMember[]>;
  readUsageBaseline(): Promise<UsageBaseline>;
  grant(userId: string, expiresAt: Date): Promise<BetaGrantResult>;
};

/** How a member of the cohort was classified before any write. */
type Classification = "create" | "identical" | "conflict";

export type GrantBetaReport = {
  /** Lines to print, in order. **No identifiers appear in any of them.** */
  readonly lines: readonly string[];
  /** Whether the process should exit zero. */
  readonly ok: boolean;
};

function classify(
  member: CohortMember,
  expiresAt: Date,
): Classification {
  if (member.subscription === null) {
    return "create";
  }

  return isIdenticalBetaGrant(member.subscription, expiresAt)
    ? "identical"
    : "conflict";
}

/**
 * Decides, and then — only if told to — grants.
 *
 * The shape is two phases with nothing between them:
 *
 * 1. **Read everything and judge the whole cohort.** Count, existing
 *    entitlements, active workers. Any reason to stop stops everything.
 * 2. **Write, one account at a time, stopping at the first refusal.**
 *
 * **There is no rollback and no retry.** The helper is idempotent, so the
 * honest answer to a partial run is to say exactly how far it got and let an
 * operator run the identical command again once they know why it stopped.
 * Deleting rows automatically would be this tool deciding, on its own, that a
 * half-granted cohort is worse than no cohort — which is a judgement about
 * people's accounts that it has no business making.
 */
export async function runGrantBeta(
  options: GrantBetaOptions,
  deps: GrantBetaDeps,
): Promise<GrantBetaReport> {
  const activeWorkerLimit = getPlanDefinition("beta").activeWorkerLimit;
  const mode = options.execute ? "EXECUTE" : "DRY-RUN";
  const expiry = options.expiresAt.toISOString();

  const cohort = await deps.readCohort();
  const baseline = await deps.readUsageBaseline();

  const header = [
    `MODE: ${mode}`,
    `EXPECTED USERS: ${options.expectedUsers}`,
    `ACTUAL USERS: ${cohort.length}`,
  ];

  const usageLines = [
    `USAGE PERIODS: ${baseline.usagePeriods}`,
    `USAGE COUNTERS: ${baseline.usageCounters}`,
    `PROVIDER USAGE EVENTS: ${baseline.providerUsageEvents}`,
  ];

  // **The count guard, before anything else is judged.** A cohort that is not
  // the cohort the operator described is not one this command may act on,
  // whatever else is true about it.
  if (cohort.length !== options.expectedUsers) {
    return {
      ok: false,
      lines: [
        ...header,
        `EXPIRY: ${expiry}`,
        ...usageLines,
        "WRITE PERFORMED: NO",
        "RESULT: BLOCKED — user count does not match --expected-users",
      ],
    };
  }

  const classified = cohort.map((member) => ({
    member,
    kind: classify(member, options.expiresAt),
  }));

  const eligible = classified.filter((entry) => entry.kind === "create");
  const identical = classified.filter((entry) => entry.kind === "identical");
  const conflicts = classified.filter((entry) => entry.kind === "conflict");
  const overLimit = cohort.filter(
    (member) => member.activeWorkers > activeWorkerLimit,
  );

  const survey = [
    ...header,
    `ELIGIBLE FOR CREATE: ${eligible.length}`,
    `IDENTICAL GRANTS PRESENT: ${identical.length}`,
    `CONFLICTS: ${conflicts.length}`,
    `ACTIVE WORKER LIMIT VIOLATIONS: ${overLimit.length}`,
    `EXPIRY: ${expiry}`,
    ...usageLines,
  ];

  if (conflicts.length > 0 || overLimit.length > 0) {
    return {
      ok: false,
      lines: [
        ...survey,
        "WRITE PERFORMED: NO",
        conflicts.length > 0
          ? "RESULT: BLOCKED — an account already has a different entitlement"
          : "RESULT: BLOCKED — an account is over the beta active worker limit",
      ],
    };
  }

  if (!options.execute) {
    return {
      ok: true,
      lines: [...survey, "WRITE PERFORMED: NO", "RESULT: READY"],
    };
  }

  // **Every member is offered to the helper, including the ones already
  // granted.** The helper answers `created: false` for those, which is the same
  // judgement the survey above made — asked of the one thing that can also act
  // on it, rather than decided twice.
  let created = 0;
  let alreadyPresent = 0;
  let failed = 0;
  let failureReason: string | null = null;

  for (const [index, entry] of classified.entries()) {
    let result: BetaGrantResult;

    try {
      result = await deps.grant(entry.member.userId, options.expiresAt);
    } catch (error) {
      failed = 1;
      // The category, never the record. A driver's complaint names tables and
      // connection strings, and neither belongs in an operator's transcript.
      failureReason =
        error instanceof Error ? error.name : "an unexpected failure";
      return {
        ok: false,
        lines: partialFailure(
          header,
          expiry,
          usageLines,
          created,
          alreadyPresent,
          failed,
          classified.length - index - 1,
          failureReason,
        ),
      };
    }

    if (!result.granted) {
      failed = 1;
      failureReason = result.reason;
      return {
        ok: false,
        lines: partialFailure(
          header,
          expiry,
          usageLines,
          created,
          alreadyPresent,
          failed,
          classified.length - index - 1,
          failureReason,
        ),
      };
    }

    if (result.created) {
      created += 1;
    } else {
      alreadyPresent += 1;
    }
  }

  const after = await deps.readUsageBaseline();

  return {
    ok: true,
    lines: [
      ...header,
      `CREATED: ${created}`,
      `ALREADY PRESENT: ${alreadyPresent}`,
      "FAILED: 0",
      `EXPIRY: ${expiry}`,
      `USAGE PERIODS: ${baseline.usagePeriods} -> ${after.usagePeriods}`,
      `USAGE COUNTERS: ${baseline.usageCounters} -> ${after.usageCounters}`,
      `PROVIDER USAGE EVENTS: ${baseline.providerUsageEvents} -> ${after.providerUsageEvents}`,
      "RESULT: SUCCESS",
    ],
  };
}

/** What a run that stopped part-way reports. Counts only. */
function partialFailure(
  header: readonly string[],
  expiry: string,
  usageLines: readonly string[],
  created: number,
  alreadyPresent: number,
  failed: number,
  remaining: number,
  reason: string,
): string[] {
  return [
    ...header,
    `CREATED: ${created}`,
    `ALREADY PRESENT: ${alreadyPresent}`,
    `FAILED: ${failed}`,
    `REMAINING NOT ATTEMPTED: ${remaining}`,
    `EXPIRY: ${expiry}`,
    ...usageLines,
    `REASON: ${reason}`,
    "RESULT: PARTIAL FAILURE",
  ];
}
