import "server-only";

import { isUniqueViolation } from "@/lib/billing/subscription-writes";
import { type DbClient, prisma } from "@/lib/prisma";

/**
 * Who is already partway through starting a subscription.
 *
 * **Coordination, and nothing else.** Nothing here says what an account is
 * entitled to — that is `Subscription`, and only reconciliation writes it.
 * Nothing here records that a provider said something — that is
 * `ProviderEventReceipt`. Nothing here reads a provider at all: there is no
 * Stripe import in this file and no network call, because the whole reason it
 * exists is to answer a question the provider cannot yet be asked.
 *
 * **The question is "has this account already started one".** A first-time
 * buyer has no customer on the provider's side, so there is nothing to look up;
 * and between the payment and the reconciliation that follows it there is a
 * window, minutes wide, in which the provider has a subscription and Koqentra
 * does not know yet. A second checkout begun in that window would create a
 * second subscription and charge somebody twice. Taking a row *before* the
 * provider is called is what closes it.
 *
 * **One row per account, and the unique index is the mechanism.** Two requests
 * racing to start a checkout cannot both create it; the one that loses reads
 * the winner's row and joins it. That is the same shape
 * `recordProviderEventReceipt` uses for a racing delivery, for the same reason:
 * a constraint the database enforces is the only kind of exclusion that holds
 * when two processes are involved.
 */

/**
 * How long an attempt holds the account's slot.
 *
 * **Longer than the provider's own session, shorter than its replay window.**
 * The session Stripe creates is given twelve hours; if the slot were freed
 * before that, a second checkout could begin while the first could still be
 * paid for — which is the thing being prevented. The provider replays an
 * identical request for twenty-four hours, so a retry inside the slot's
 * lifetime still resolves to the same session rather than a new one. Eighteen
 * hours sits between the two with room on both sides.
 *
 * **Written once.** The number belongs to this decision and nothing else reads
 * it, so there is nowhere for a second copy to drift.
 */
export const CHECKOUT_ATTEMPT_TTL_MS = 18 * 60 * 60 * 1000;

/** The plans a checkout can be started for: the ones that have a price. */
export const checkoutAttemptPlans = ["lite", "standard", "pro"] as const;

export type CheckoutAttemptPlan = (typeof checkoutAttemptPlans)[number];

/**
 * Whether a plan can be bought.
 *
 * `trial` and `beta` are plans an account can be *on* and cannot be sold: one
 * begins by activating a worker, the other is granted by an operator. Narrowed
 * here rather than by the database, the same way `isPlan` narrows
 * `Subscription.plan`.
 */
export function isCheckoutAttemptPlan(
  value: unknown,
): value is CheckoutAttemptPlan {
  return (
    typeof value === "string" &&
    (checkoutAttemptPlans as readonly string[]).includes(value)
  );
}

/**
 * How far an attempt has got.
 *
 * **Three, and they are about coordination rather than about money.** A
 * checkout that was paid for and one that expired unpaid are both `closed`
 * here, because the question this answers is whether the account may start
 * another — and for that, they are the same answer. What happened to the
 * payment is the provider's to say, and it says it through the webhook.
 */
export const checkoutAttemptStates = ["starting", "open", "closed"] as const;

export type CheckoutAttemptState = (typeof checkoutAttemptStates)[number];

export function isCheckoutAttemptState(
  value: unknown,
): value is CheckoutAttemptState {
  return (
    typeof value === "string" &&
    (checkoutAttemptStates as readonly string[]).includes(value)
  );
}

/** One attempt, as a caller needs to see it. */
export type CheckoutAttempt = {
  readonly id: string;
  readonly plan: CheckoutAttemptPlan;
  readonly state: CheckoutAttemptState;
  readonly providerCheckoutSessionId: string | null;
  readonly expiresAt: Date;
  /**
   * When this attempt was taken.
   *
   * **Read because a retry has to agree with itself.** The provider refuses an
   * idempotency key reused with different parameters, so anything derived from
   * the clock has to be derived from a *stored* instant rather than from the
   * current one — a session expiry computed as "now plus twelve hours" would be
   * a different number on the second attempt at the same request. This is that
   * instant, and it does not move.
   */
  readonly createdAt: Date;
};

/**
 * What `beginCheckoutAttempt` did, and why.
 *
 * **The disposition is what the caller acts on**, not the row: whether to send
 * somebody to a session that already exists, to create one, or to ask a
 * question first. Each name says which of those it is.
 */
export type CheckoutAttemptDisposition =
  /** Nothing was in progress. A fresh attempt is waiting for its session. */
  | "created"
  /** An attempt exists but never got a session — the caller creates one, with
   * the same id and therefore the same idempotency key. */
  | "resumed-starting"
  /** An attempt has a session already. Send them back to it. */
  | "resumed-open"
  /** What was there had been closed or had lapsed. It is gone, and this is a
   * new attempt with a new id. */
  | "replaced";

export type BeginCheckoutAttemptResult =
  | {
      readonly outcome: "attempt";
      readonly disposition: CheckoutAttemptDisposition;
      readonly attempt: CheckoutAttempt;
    }
  /**
   * A live attempt for a different plan.
   *
   * **Not replaced, deliberately.** The account is partway through buying
   * something else, and possibly looking at its payment page right now.
   * Discarding that silently would be Koqentra deciding which purchase the
   * person meant — so the existing attempt is reported and the decision is left
   * with them. What follows is a separate flow: they confirm, the provider's
   * session is expired, the attempt is closed, and a new one is begun.
   */
  | {
      readonly outcome: "plan-switch-required";
      readonly attempt: CheckoutAttempt;
    };

/** Which columns describe an attempt. */
const ATTEMPT_FIELDS = {
  id: true,
  plan: true,
  state: true,
  providerCheckoutSessionId: true,
  expiresAt: true,
  createdAt: true,
} as const;

type StoredAttempt = {
  id: string;
  plan: string;
  state: string;
  providerCheckoutSessionId: string | null;
  expiresAt: Date;
  createdAt: Date;
};

/**
 * A stored row this version does not recognise.
 *
 * **Refused rather than guessed at.** A `state` or `plan` written by a version
 * that knew more is not something to interpret: treating an unknown state as
 * `closed` would discard a checkout somebody may be in the middle of, and
 * treating it as `open` would send them to a session that may not exist.
 */
export class UnreadableCheckoutAttempt extends Error {
  constructor(readonly attemptId: string) {
    super("A checkout attempt was stored in a shape this version cannot read");
    this.name = "UnreadableCheckoutAttempt";
  }
}

/** An attempt whose session does not match the one being recorded. */
export class CheckoutSessionConflict extends Error {
  constructor(readonly attemptId: string) {
    super("A checkout attempt already names a different provider session");
    this.name = "CheckoutSessionConflict";
  }
}

function readStored(row: StoredAttempt): CheckoutAttempt {
  if (!isCheckoutAttemptPlan(row.plan) || !isCheckoutAttemptState(row.state)) {
    throw new UnreadableCheckoutAttempt(row.id);
  }

  return {
    id: row.id,
    plan: row.plan,
    state: row.state,
    providerCheckoutSessionId: row.providerCheckoutSessionId,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/**
 * Takes the account's own row so that its attempt can be decided safely.
 *
 * **The self-assignment is the lock**, the same one `claimWorkerCreation`
 * takes and for the same reason: writing `id` back to the value it already has
 * produces a real `UPDATE`, which holds the row for the rest of the
 * transaction. Reading the attempt and then replacing it is a check-then-act,
 * and under READ COMMITTED two requests would otherwise both read "expired"
 * and both insert.
 *
 * **`data: {}` must never be used instead.** Prisma issues no `UPDATE` at all
 * for an empty `data` and turns the call into a `SELECT`, which takes no lock.
 */
async function lockAccountForCheckout(
  client: DbClient,
  userId: string,
): Promise<void> {
  await client.user.update({ where: { id: userId }, data: { id: userId } });
}

/**
 * Gives this account the attempt it should be using, creating one if it has
 * none that still counts.
 *
 * **Decided under the account's lock, and with no provider in sight.** Every
 * branch below is a read and a write against one table; the session the
 * provider will be asked for is created afterwards, outside the transaction,
 * by the caller. A transaction that waited on a network would hold this lock
 * across it — see `startTrialOnFirstWorkerActivation`, which refuses to do the
 * same thing for the same reason.
 *
 * **A replaced attempt is deleted and a new row created, never rewritten.**
 * The id is what the provider's idempotency key is built from, so an id that
 * survived into a second attempt would replay the first attempt's session —
 * and Stripe refuses a key reused with different parameters outright, which is
 * the failure that would surface. A new attempt is a new id.
 */
export async function beginCheckoutAttempt(input: {
  readonly userId: string;
  readonly plan: CheckoutAttemptPlan;
  readonly now?: Date;
  readonly client?: DbClient;
}): Promise<BeginCheckoutAttemptResult> {
  const client = input.client ?? prisma;
  const now = input.now ?? new Date();

  const run = async (tx: DbClient): Promise<BeginCheckoutAttemptResult> => {
    await lockAccountForCheckout(tx, input.userId);

    const existing = await tx.checkoutAttempt.findUnique({
      where: { userId: input.userId },
      select: ATTEMPT_FIELDS,
    });

    if (existing !== null) {
      const attempt = readStored(existing);
      // **Lapsed first, before the plan is looked at.** An attempt nobody can
      // pay for any more is not a purchase in progress, so it raises no
      // question about which plan was meant.
      const lapsed =
        attempt.state === "closed" || attempt.expiresAt.getTime() <= now.getTime();

      if (!lapsed) {
        if (attempt.plan !== input.plan) {
          return { outcome: "plan-switch-required", attempt };
        }

        return {
          outcome: "attempt",
          disposition:
            attempt.state === "open" ? "resumed-open" : "resumed-starting",
          attempt,
        };
      }

      await tx.checkoutAttempt.delete({ where: { id: attempt.id } });
    }

    const created = await tx.checkoutAttempt.create({
      data: {
        userId: input.userId,
        plan: input.plan,
        state: "starting",
        expiresAt: new Date(now.getTime() + CHECKOUT_ATTEMPT_TTL_MS),
      },
      select: ATTEMPT_FIELDS,
    });

    return {
      outcome: "attempt",
      disposition: existing === null ? "created" : "replaced",
      attempt: readStored(created),
    };
  };

  try {
    return "$transaction" in client && typeof client.$transaction === "function"
      ? await (client as typeof prisma).$transaction(run)
      : await run(client);
  } catch (error) {
    // **A lost race is answered, not raised.** Something created this
    // account's attempt between the lock and the insert — which the lock is
    // supposed to prevent, and does on PostgreSQL, but a caller that passed a
    // client without one would see it. Whatever is there now is what the
    // account is using, so it is read and returned rather than retried.
    if (isUniqueViolation(error)) {
      const raced = await client.checkoutAttempt.findUnique({
        where: { userId: input.userId },
        select: ATTEMPT_FIELDS,
      });

      if (raced !== null) {
        const attempt = readStored(raced);

        if (attempt.plan !== input.plan) {
          return { outcome: "plan-switch-required", attempt };
        }

        return {
          outcome: "attempt",
          disposition:
            attempt.state === "open" ? "resumed-open" : "resumed-starting",
          attempt,
        };
      }
    }

    throw error;
  }
}

/** What recording a session came to. */
export type MarkCheckoutAttemptOpenResult =
  /** The attempt now names this session. */
  | { readonly outcome: "opened" }
  /** It already named this session. Nothing was written. */
  | { readonly outcome: "already-open" }
  /** No attempt with this id, or it has since been replaced. */
  | { readonly outcome: "not-found" };

/**
 * Records the session an attempt is being paid through.
 *
 * **Conditional, so a stale caller cannot overwrite a live attempt.** The
 * update asks for the id *and* a state of `starting` *and* a session that is
 * still unset — the same shape `claimReconciliation` uses, where the condition
 * on the row is what makes the write safe rather than a check performed
 * beforehand.
 *
 * **The same session twice is a success.** A retry after a crash between the
 * provider's answer and this write arrives with the session it already
 * recorded; answering `already-open` lets that retry finish instead of failing
 * on a row that is exactly as it should be.
 *
 * **A different session is refused outright.** Two sessions for one attempt
 * means two ways to pay for the same thing, and choosing between them is not
 * something this can do correctly — so it raises rather than picks.
 */
export async function markCheckoutAttemptOpen(input: {
  readonly attemptId: string;
  readonly providerCheckoutSessionId: string;
  readonly client?: DbClient;
}): Promise<MarkCheckoutAttemptOpenResult> {
  const client = input.client ?? prisma;

  const { count } = await client.checkoutAttempt.updateMany({
    where: {
      id: input.attemptId,
      state: "starting",
      providerCheckoutSessionId: null,
    },
    data: {
      state: "open",
      providerCheckoutSessionId: input.providerCheckoutSessionId,
    },
  });

  if (count === 1) {
    return { outcome: "opened" };
  }

  const current = await client.checkoutAttempt.findUnique({
    where: { id: input.attemptId },
    select: ATTEMPT_FIELDS,
  });

  if (current === null) {
    return { outcome: "not-found" };
  }

  if (current.providerCheckoutSessionId === input.providerCheckoutSessionId) {
    return { outcome: "already-open" };
  }

  throw new CheckoutSessionConflict(input.attemptId);
}

/** What closing came to. */
export type CloseCheckoutAttemptResult =
  | { readonly outcome: "closed" }
  /** Already closed. Nothing was written. */
  | { readonly outcome: "already-closed" }
  | { readonly outcome: "not-found" };

/**
 * Gives up an attempt's hold on the account's slot.
 *
 * **Closed, not deleted.** The next `beginCheckoutAttempt` replaces the row,
 * and doing it there rather than here means one place decides what replacing
 * looks like. It also means a close that raced a begin cannot leave the
 * account with no row at all.
 *
 * **The session id is kept.** Clearing it would buy nothing — a closed attempt
 * grants no slot whatever it names — and losing it would leave nothing to
 * check against if the provider later reports that session. Coordination has
 * no use for it; reading a log afterwards does.
 *
 * **Either state may be closed.** A cancelled return arrives on an `open`
 * attempt and a confirmed plan switch may arrive on either, so this does not
 * insist on one.
 */
export async function closeCheckoutAttempt(input: {
  readonly attemptId: string;
  readonly client?: DbClient;
}): Promise<CloseCheckoutAttemptResult> {
  const client = input.client ?? prisma;

  const { count } = await client.checkoutAttempt.updateMany({
    where: { id: input.attemptId, state: { not: "closed" } },
    data: { state: "closed" },
  });

  if (count === 1) {
    return { outcome: "closed" };
  }

  const current = await client.checkoutAttempt.findUnique({
    where: { id: input.attemptId },
    select: { state: true },
  });

  return current === null
    ? { outcome: "not-found" }
    : { outcome: "already-closed" };
}
