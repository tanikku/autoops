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
  | { readonly status: "full" };

export async function admitToPublicBeta(
  client: PrismaClient,
  userId: string,
  limit: number,
): Promise<AdmissionOutcome> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PUBLIC_BETA_ADMISSION_LOCK}::bigint)`;

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
 * 2. An address on the internal allowlist is let in without taking a place.
 * 3. Somebody with an account or a place already is let in, in either mode and
 *    however full the beta is — neither the mode nor the cap locks out an
 *    existing user.
 * 4. Anybody else is refused in Closed Beta. In Public Beta they are refused
 *    while signup is closed, and otherwise admitted if a place is left.
 * 5. A place this sign-in created is reported to the operator, after the
 *    admission has committed. The report cannot change the answer: whatever it
 *    does, a participant who was let in is let in.
 *
 * The allowlist is looked at before the database only because it needs no
 * query; an address on it would be let in either way.
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
    isKnown: (userId: string) => Promise<boolean>;
    admit: (userId: string, limit: number) => Promise<AdmissionOutcome>;
    notifyJoined: (joined: { participants: number; limit: number; admittedAt: Date }) => Promise<void>;
  },
): Promise<boolean | string> {
  const { mode, profile, userId, allowlist, signup } = input;

  if (!profile || profile.email_verified !== true || !userId) {
    return false;
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
