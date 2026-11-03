import {
  checkTombstone,
  lockSubject,
  type TombstoneStatus,
} from "@/lib/account-tombstone";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import {
  type AccessMode,
  type PublicBetaSignup,
  SIGNUP_CLOSED_PATH,
  SIGNUP_FULL_PATH,
} from "@/lib/beta-access";

/**
 * Who may join the Public Beta, counted so that the cap cannot be overrun.
 *
 * **An admission is a sign-in, not a trial.** A new participant takes a place
 * the moment their first sign-in is allowed, whether or not they ever start a
 * trial. Places are keyed by the Google subject — the id the account will have —
 * because the account row itself is only written later, by the first action
 * that needs it.
 *
 * **Counted under one lock.** Every admission takes the same transaction-scoped
 * advisory lock before it counts, so two people arriving for the last place are
 * answered one after the other: the first is let in, the second sees the cap.
 * Counting and then inserting without it would let both through.
 */

/** The advisory lock every admission takes. An arbitrary, fixed key. */
export const PUBLIC_BETA_ADMISSION_LOCK = 7_204_118_001;

/**
 * `joined` is a place this call created; `admitted` is one that already
 * existed. Only `joined` carries the count, read under the same lock right
 * after the insert, so it is the participant number this admission actually
 * got — not whatever the table holds by the time anyone reads it again.
 */
export type AdmissionOutcome =
  | { readonly status: "joined"; readonly participants: number; readonly admittedAt: Date }
  | { readonly status: "admitted" }
  | { readonly status: "full" }
  /**
   * The subject was deleted, or whether it was could not be checked. No place
   * is taken and none is kept. One answer for both, because the person signing
   * in is told the same thing either way.
   */
  | { readonly status: "refused" };

/**
 * **Two locks, always in this order: the subject's, then the admission lock.**
 * Every transaction that takes both takes them this way round, so none can be
 * holding the second while it waits for the first.
 *
 * **The tombstone is checked under both.** A sign-in checks it too, earlier
 * and without a lock; that check is a courtesy. This one is the one that holds,
 * because a deletion takes the same locks and removes the subject's place in
 * the same transaction as it writes the tombstone — so a place cannot be
 * written after it, nor an old one kept.
 */
export async function admitToPublicBeta(
  client: PrismaClient,
  userId: string,
  limit: number,
): Promise<AdmissionOutcome> {
  return client.$transaction(async (tx) => {
    await lockSubject(tx, userId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PUBLIC_BETA_ADMISSION_LOCK}::bigint)`;

    // Before the existing place is looked at: a deleted subject keeps nothing,
    // and one that cannot be checked is not let in on the strength of a row.
    if ((await checkTombstone(tx, userId)) !== "clear") {
      return { status: "refused" };
    }

    // Somebody already let in keeps their place without taking another.
    const existing = await tx.publicBetaAdmission.findUnique({
      where: { userId },
      select: { userId: true },
    });
    if (existing !== null) {
      return { status: "admitted" };
    }

    if ((await tx.publicBetaAdmission.count()) >= limit) {
      return { status: "full" };
    }

    const { admittedAt } = await tx.publicBetaAdmission.create({
      data: { userId },
      select: { admittedAt: true },
    });
    const participants = await tx.publicBetaAdmission.count();
    return { status: "joined", participants, admittedAt };
  });
}

/** Whether this subject already has an account or a place. Read only. */
export async function isKnownSubject(client: PrismaClient, userId: string): Promise<boolean> {
  const [user, admission] = await Promise.all([
    client.user.findUnique({ where: { id: userId }, select: { id: true } }),
    client.publicBetaAdmission.findUnique({ where: { userId }, select: { userId: true } }),
  ]);

  return user !== null || admission !== null;
}

/**
 * The answer to a sign-in: `true`, `false`, or where to send a new participant
 * the Public Beta cannot take in.
 *
 * In order:
 *
 * 1. A verified Google address and a subject are required, as every sign-in
 *    has always required a verified address.
 * 2. A deleted subject is refused — before the allowlist, before an existing
 *    place, in either mode. When whether it was deleted cannot be checked,
 *    only somebody already known is let in: a deletion removes both the
 *    account and the place, so a subject that still has one was not deleted.
 * 3. An address on the internal allowlist is let in without taking a place.
 * 4. Somebody with an account or a place already is let in, in either mode and
 *    however full the beta is — neither the mode nor the cap locks out an
 *    existing user.
 * 5. Anybody else is refused in Closed Beta. In Public Beta they are refused
 *    while signup is closed, and otherwise admitted if a place is left.
 * 6. A place this sign-in created is reported to the operator, after the
 *    admission has committed. The report cannot change the answer: whatever it
 *    does, a participant who was let in is let in.
 *
 * **Step 2 is not the only check.** It runs without a lock, so a deletion can
 * land just after it; the admission checks again under its locks, and an
 * account row is never written for a deleted subject (`ensureUser`). What this
 * step buys is that a deleted person is turned away at the door rather than
 * signed in to an account that will refuse every write.
 *
 * A refusal says nothing about why: Auth.js returns `AccessDenied`, the same
 * as any other refused sign-in.
 */
export async function decideSignIn(
  input: {
    mode: AccessMode;
    profile: { email?: string | null; email_verified?: boolean | null } | undefined;
    userId: string | undefined;
    allowlist: Set<string>;
    signup: PublicBetaSignup;
  },
  deps: {
    checkTombstone: (userId: string) => Promise<TombstoneStatus>;
    isKnown: (userId: string) => Promise<boolean>;
    admit: (userId: string, limit: number) => Promise<AdmissionOutcome>;
    notifyJoined: (joined: { participants: number; limit: number; admittedAt: Date }) => Promise<void>;
  },
): Promise<boolean | string> {
  const { mode, profile, userId, allowlist, signup } = input;

  if (!profile || profile.email_verified !== true || !userId) {
    return false;
  }

  const tombstone = await deps.checkTombstone(userId);

  if (tombstone === "deleted") {
    return false;
  }

  if (tombstone === "unverifiable") {
    return deps.isKnown(userId);
  }

  const email = profile.email?.trim().toLowerCase();
  if (email !== undefined && email !== "" && allowlist.has(email)) {
    return true;
  }

  if (await deps.isKnown(userId)) {
    return true;
  }

  if (mode !== "public-beta") {
    return false;
  }

  if (!signup.enabled || signup.limit <= 0) {
    return SIGNUP_CLOSED_PATH;
  }

  const outcome = await deps.admit(userId, signup.limit);
  if (outcome.status === "refused") {
    return false;
  }

  if (outcome.status === "full") {
    return SIGNUP_FULL_PATH;
  }

  if (outcome.status === "joined") {
    try {
      await deps.notifyJoined({
        participants: outcome.participants,
        limit: signup.limit,
        admittedAt: outcome.admittedAt,
      });
    } catch {
      // The notifier already never throws; this keeps that from being the only
      // thing between a failed email and a refused sign-in.
    }
  }

  return true;
}
