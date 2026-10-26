import "server-only";

import { closeCheckoutAttempt } from "@/lib/billing/checkout-attempt";
import type { ProviderSessionState } from "@/lib/billing/checkout";
import { closeSettledCheckoutAttempt } from "@/lib/billing/checkout-cleanup";
import { describeBillingError } from "@/lib/billing/error-category";
import { enqueueReconciliation } from "@/lib/billing/reconciliation-queue";
import { type DbClient, prisma } from "@/lib/prisma";

/**
 * Finding a paid checkout that no delivery ever announced.
 *
 * **The gap the rest of reconciliation cannot see.** A delivery makes a row
 * owing, and the periodic resync revisits rows that exist; a first purchase
 * whose every subscription event was lost has no row at all. The account is
 * refused a second checkout — its session is paid — and nothing would ever
 * reconcile the first. What it does leave behind is its open attempt and the
 * session it was paid through, and the session names the subscription.
 *
 * **It decides nothing about whose subscription that is.** It puts the
 * subscription in line exactly as a delivery would, and the reconciliation reads
 * the owner, the plan and the world from the provider, as it does for every
 * other row. Nothing here writes an entitlement, and nothing here trusts the
 * attempt's account for anything but finding the attempt.
 *
 * **It never closes a paid attempt on its own say-so.** A paid attempt is closed
 * by the activation that settles it — here only by re-running that same close,
 * under the same conditions, when the activation is already on record and the
 * close after it was what failed.
 */

/**
 * How long an attempt is left to the ordinary path before it is looked at here.
 *
 * Long enough that a delivery which is merely slow has arrived and been
 * reconciled — measured in production at under a minute — so this reads only
 * the attempts that path did not settle.
 */
export const CHECKOUT_RECOVERY_DELAY_MS = 15 * 60 * 1000;

/**
 * How many attempts one sweep looks at, and so the most provider reads it makes.
 *
 * **Two newest and one roaming.** Attempts that are never going to settle — a
 * paid one whose reconciliation keeps refusing, one a failed close left open —
 * stay eligible indefinitely, and taking the oldest would let three of them hold
 * every slot for good. The newest two are therefore always read, so a purchase
 * that has just become eligible is not queued behind them; the third slot goes
 * to one of the older ones at random, so they keep being read too. That removes
 * the permanent head-of-line block; it does not promise any one older attempt a
 * turn within a fixed time.
 */
export const CHECKOUT_RECOVERY_LIMIT = 3;
const NEWEST_SLOTS = 2;

/** What looking at one attempt came to. Categories only. */
export type CheckoutRecoveryOutcome =
  /** The activation was on record and only its close had failed; closed now. */
  | "close-retried"
  /** Something else closed it first. */
  | "already-closed"
  /** Paid, and its subscription had no row: one now owes a look. */
  | "enqueued"
  /** Paid, and its subscription already has a row. Nothing written. */
  | "already-known"
  /** Nobody can pay through it any more; closed. */
  | "lapsed-closed"
  /** Still payable. Nothing written. */
  | "payable"
  /** A session that could not be told, or a paid one naming no subscription. */
  | "unreadable"
  /** A read or a write failed. Nothing changed; the next sweep asks again. */
  | "failed";

/** What reading sessions needs: the provider's name, and the read itself. */
export type CheckoutSessionReader = {
  readonly provider: string;
  readSession(sessionId: string): Promise<ProviderSessionState>;
};

export type CheckoutSessionReaderResolver = () =>
  | CheckoutSessionReader
  | { readonly unavailable: string };

type Candidate = {
  readonly id: string;
  readonly userId: string;
  readonly providerCheckoutSessionId: string;
};

const CANDIDATE_FIELDS = {
  id: true,
  userId: true,
  providerCheckoutSessionId: true,
} as const;

const NEWEST_FIRST = [{ createdAt: "desc" }, { id: "desc" }] as const;

function eligibleAt(now: Date) {
  return {
    state: "open",
    providerCheckoutSessionId: { not: null },
    createdAt: { lte: new Date(now.getTime() - CHECKOUT_RECOVERY_DELAY_MS) },
  };
}

function asCandidate(row: {
  id: string;
  userId: string;
  providerCheckoutSessionId: string | null;
}): Candidate | null {
  return row.providerCheckoutSessionId === null
    ? null
    : { id: row.id, userId: row.userId, providerCheckoutSessionId: row.providerCheckoutSessionId };
}

/**
 * The attempts this sweep looks at: the newest two, and one of the rest.
 *
 * **The roaming one is chosen by offset, not by the database.** The rest are
 * counted and one is taken at a random position in the same order, so nothing
 * here depends on a database's own random function. An attempt that became
 * eligible between the queries can shift the order by one; a repeat of a newest
 * row is dropped rather than read twice.
 *
 * @param random returns a number in [0, 1); injected so a test can choose
 */
export async function selectCheckoutRecoveryCandidates(
  client: DbClient,
  now: Date,
  random: () => number,
): Promise<Candidate[]> {
  const where = eligibleAt(now);

  const newest = (
    await client.checkoutAttempt.findMany({
      where,
      orderBy: [...NEWEST_FIRST],
      take: NEWEST_SLOTS,
      select: CANDIDATE_FIELDS,
    })
  )
    .map(asCandidate)
    .filter((row): row is Candidate => row !== null);

  if (newest.length < NEWEST_SLOTS) {
    return newest;
  }

  const rest = (await client.checkoutAttempt.count({ where })) - NEWEST_SLOTS;

  if (rest <= 0) {
    return newest;
  }

  const offset = Math.min(rest - 1, Math.floor(random() * rest));

  const roaming = (
    await client.checkoutAttempt.findMany({
      where,
      orderBy: [...NEWEST_FIRST],
      skip: NEWEST_SLOTS + offset,
      take: CHECKOUT_RECOVERY_LIMIT - NEWEST_SLOTS,
      select: CANDIDATE_FIELDS,
    })
  )
    .map(asCandidate)
    .filter((row): row is Candidate => row !== null)
    .filter((row) => !newest.some((taken) => taken.id === row.id));

  return [...newest, ...roaming];
}

/**
 * Closes an attempt whose activation is already on record, if that is all
 * that was left undone.
 *
 * **The close the activation would have made, and nothing looser.** The account
 * has to hold a bought, active subscription — which only a reconciliation that
 * applied an activation writes — and `closeSettledCheckoutAttempt` then applies
 * its own conditions unchanged: the same plan, and an attempt taken no later
 * than the subscription's period began. A plan that does not match is left
 * open, exactly as the activation left it.
 *
 * @returns the outcome when this settled the attempt, or null to go on and
 *   read its session
 */
async function retrySettledClose(
  client: DbClient,
  candidate: Candidate,
): Promise<CheckoutRecoveryOutcome | null> {
  const subscription = await client.subscription.findUnique({
    where: { userId: candidate.userId },
    select: {
      source: true,
      state: true,
      plan: true,
      currentPeriodStart: true,
      providerSubscriptionId: true,
    },
  });

  if (
    subscription === null ||
    subscription.source !== "stripe" ||
    subscription.state !== "active" ||
    subscription.providerSubscriptionId === null ||
    subscription.currentPeriodStart === null
  ) {
    return null;
  }

  const closed = await closeSettledCheckoutAttempt({
    userId: candidate.userId,
    plan: subscription.plan,
    subscriptionStartedAt: subscription.currentPeriodStart,
    client,
  });

  switch (closed.outcome) {
    case "closed":
      return "close-retried";
    case "already-closed":
      return "already-closed";
    default:
      // A different plan, a later attempt, or no attempt: not this close's to
      // make. The session is read instead.
      return null;
  }
}

/** Looks at one attempt and does the one thing its state allows. */
async function recoverOne(
  client: DbClient,
  candidate: Candidate,
  reader: CheckoutSessionReader | { readonly unavailable: string },
  now: Date,
): Promise<string> {
  try {
    const settled = await retrySettledClose(client, candidate);

    if (settled !== null) {
      return settled;
    }

    if ("unavailable" in reader) {
      return reader.unavailable;
    }

    const session = await reader.readSession(candidate.providerCheckoutSessionId);

    switch (session.kind) {
      case "paid":
        if (session.providerSubscriptionId === null) {
          return "unreadable";
        }

        return (await enqueueReconciliation(
          reader.provider,
          session.providerSubscriptionId,
          client,
          now,
        )) === "created"
          ? "enqueued"
          : "already-known";

      case "lapsed":
        // Conditional on the attempt still being open, so a close that raced
        // this one — or an activation — is not undone or repeated.
        await closeCheckoutAttempt({ attemptId: candidate.id, client });
        return "lapsed-closed";

      case "payable":
        return "payable";

      default:
        return "unreadable";
    }
  } catch (error) {
    // **The category, never the cause.** A provider's error text can quote the
    // session it could not find; this line is read by whoever watches the tick.
    console.error(
      `[billing] checkout recovery failed for one attempt — ${describeBillingError(error)}`,
    );

    return "failed";
  }
}

/**
 * Looks at up to three open, paid-or-payable attempts and settles what it can.
 *
 * **The reader is resolved only when there is an attempt to read**, so a
 * deployment with no checkout in flight builds no provider client. One
 * attempt's failure is its own and the rest are still looked at.
 */
export async function recoverCheckouts(input: {
  readonly client?: DbClient;
  readonly now: Date;
  readonly random: () => number;
  readonly resolveReader: CheckoutSessionReaderResolver;
}): Promise<string[]> {
  const client = input.client ?? prisma;
  const candidates = await selectCheckoutRecoveryCandidates(client, input.now, input.random);

  if (candidates.length === 0) {
    return [];
  }

  const reader = input.resolveReader();
  const outcomes: string[] = [];

  for (const candidate of candidates) {
    outcomes.push(await recoverOne(client, candidate, reader, input.now));
  }

  return outcomes;
}
