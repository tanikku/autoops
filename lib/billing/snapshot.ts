import { isPaidPlan } from "@/lib/billing/events";
import type { PlanId } from "@/lib/plans";

/**
 * What a billing provider currently says about one subscription.
 *
 * **A statement about now, not a notification about then.** The layer that
 * came before this asked "what happened, and when did the provider say it
 * happened" — and that question has no safe answer: at least one provider
 * records event times in whole seconds, says plainly that delivery order is not
 * guaranteed, and tells integrators not to use those timestamps to order
 * anything. So nothing here carries an event id, an event name or a provider
 * clock to be compared. What it carries is the state of the subscription at the
 * moment it was read.
 *
 * **Deliberately smaller than any provider's object.** There is no invoice, no
 * price, no customer email, no raw payload and no provider status string. None
 * of them is needed to decide what an account may do, and a field that existed
 * would eventually be read by something that should not know about billing at
 * all. Translating a provider's object down to this is its adapter's whole job.
 */
export type ProviderSubscriptionSnapshot = {
  /** Who is billing. Opaque: nothing branches on it. */
  readonly provider: string;
  readonly providerCustomerId: string;
  readonly providerSubscriptionId: string;
  /** The account, resolved by the adapter from the provider's own binding. */
  readonly userId: string;
  /**
   * Which paid plan applies now, or null when the provider names one Koqentra
   * does not sell. **Null is a refusal, never a default** — guessing would hand
   * somebody allowances nobody bought.
   */
  readonly plan: PlanId | null;
  /**
   * Whether the subscription is in force, in question, or over.
   *
   * **Three words instead of a provider's statuses**, because that is all the
   * domain needs. Which of a provider's states map to which — and how many
   * observations a provider's recoverable failure state must be seen in before
   * it counts as over — is the adapter's and the orchestration's, not this
   * type's.
   */
  readonly entitlement: "entitled" | "grace" | "ended";
  /** Whether the provider has a cancellation scheduled for the period's end. */
  readonly cancelAtPeriodEnd: boolean;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  /**
   * When this was read from the provider.
   *
   * **Observation, not ordering.** It records how fresh a successful
   * reconciliation was; it is never compared against another snapshot's to
   * decide which is newer. That question is settled by holding the
   * reconciliation lease across the read, not by any clock.
   */
  readonly observedAt: Date;
};

/** Why a snapshot could not be used at all. */
export type SnapshotDefect =
  | "provider-missing"
  | "customer-missing"
  | "subscription-missing"
  | "user-missing"
  | "run-missing"
  | "observed-at-invalid"
  | "period-half-present"
  | "period-not-forwards"
  | "entitled-without-plan";

function isUsableDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function isPresent(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * What is structurally wrong with a snapshot, or null when nothing is.
 *
 * **Checked before anything is read or written.** An adapter that translated
 * something wrong should learn it from the answer rather than from a
 * half-applied entitlement, and a check made after the first write would have
 * to decide what to do about that write.
 *
 * **Nothing is inferred.** A period with one end missing is refused rather than
 * completed, and an entitled subscription whose plan is unknown is refused
 * rather than given a default.
 */
export function findSnapshotDefect(
  snapshot: ProviderSubscriptionSnapshot,
  reconciliationRunId: string,
): SnapshotDefect | null {
  if (!isPresent(snapshot.provider)) {
    return "provider-missing";
  }

  if (!isPresent(snapshot.providerCustomerId)) {
    return "customer-missing";
  }

  if (!isPresent(snapshot.providerSubscriptionId)) {
    return "subscription-missing";
  }

  if (!isPresent(snapshot.userId)) {
    return "user-missing";
  }

  if (!isPresent(reconciliationRunId)) {
    return "run-missing";
  }

  if (!isUsableDate(snapshot.observedAt)) {
    return "observed-at-invalid";
  }

  const hasStart = isUsableDate(snapshot.periodStart);
  const hasEnd = isUsableDate(snapshot.periodEnd);

  if (hasStart !== hasEnd) {
    return "period-half-present";
  }

  // A period that does not move forwards is not a period: it would open a
  // window nothing could ever be counted in.
  if (
    hasStart &&
    hasEnd &&
    (snapshot.periodStart as Date).getTime() >=
      (snapshot.periodEnd as Date).getTime()
  ) {
    return "period-not-forwards";
  }

  if (
    snapshot.entitlement === "entitled" &&
    (snapshot.plan === null || !isPaidPlan(snapshot.plan))
  ) {
    return "entitled-without-plan";
  }

  return null;
}

/** The Koqentra state a snapshot describes. */
export function desiredState(
  snapshot: ProviderSubscriptionSnapshot,
): "active" | "grace" | "canceled_active" | "inactive" {
  if (snapshot.entitlement === "ended") {
    return "inactive";
  }

  if (snapshot.entitlement === "grace") {
    return "grace";
  }

  return snapshot.cancelAtPeriodEnd ? "canceled_active" : "active";
}

/** The period, once both ends are known to be usable. */
export function snapshotPeriod(
  snapshot: ProviderSubscriptionSnapshot,
): { start: Date; end: Date } | null {
  if (!isUsableDate(snapshot.periodStart) || !isUsableDate(snapshot.periodEnd)) {
    return null;
  }

  return { start: snapshot.periodStart, end: snapshot.periodEnd };
}
