import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * Granting the Closed Beta's allowance to an account that already has one in
 * practice.
 *
 * **Not reachable from anywhere.** No route, no server action, no page, no
 * startup hook, and nothing in a migration calls it. It is a function an
 * operator can call from a server-side context on purpose, and the only way to
 * run it is to mean to.
 *
 * **It refuses more often than it grants, and that is the design.** The five
 * accounts this exists for are real people using Koqentra today; the way to
 * harm them is not to fail to grant something, it is to overwrite something
 * they already have. So a paid plan, a running trial, or any grant that is not
 * exactly this one is left alone and reported rather than replaced.
 */

/** Prisma's code for a unique constraint that would have been broken. */
const UNIQUE_VIOLATION = "P2002";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/** The plan, state and provenance a beta grant always has. */
const BETA_GRANT = { plan: "beta", state: "active", source: "admin" } as const;

export type BetaGrantResult =
  /** Granted now, or already exactly this grant. */
  | { readonly granted: true; readonly created: boolean }
  /** No such account. Nothing was written. */
  | { readonly granted: false; readonly reason: "unknown-user" }
  /**
   * The account already has an entitlement that is not this grant — a plan, a
   * trial, or a grant ending on another date. **Nothing was written.**
   */
  | { readonly granted: false; readonly reason: "already-entitled" };

type ExistingGrant = {
  plan: string;
  state: string;
  source: string;
  expiresAt: Date | null;
};

/**
 * Whether what is already there is the very grant being asked for.
 *
 * **All four fields, including the date.** A beta grant ending on a different
 * day is a different grant, and treating it as the same one would let a second
 * call quietly move an expiry somebody chose — which is the overwriting this
 * whole function exists to refuse.
 */
function isSameGrant(existing: ExistingGrant, expiresAt: Date): boolean {
  return (
    existing.plan === BETA_GRANT.plan &&
    existing.state === BETA_GRANT.state &&
    existing.source === BETA_GRANT.source &&
    existing.expiresAt !== null &&
    existing.expiresAt.getTime() === expiresAt.getTime()
  );
}

const EXISTING_SELECT = {
  plan: true,
  state: true,
  source: true,
  expiresAt: true,
} as const;

/**
 * Gives one account the beta allowance until a date.
 *
 * **`expiresAt` is required, and there is no overload without it.** A grant
 * with no end is one nobody ever has to decide about again, and the decision
 * not to make would be "when does the Closed Beta stop being free". Making the
 * date unavoidable is what keeps that question in front of somebody.
 *
 * **No provider identifiers are written.** This entitlement was not bought, so
 * there is nothing on the other side of it to point at, and a column filled in
 * to look complete would be a claim about a customer who does not exist.
 */
export async function grantBetaSubscription(
  userId: string,
  expiresAt: Date,
): Promise<BetaGrantResult> {
  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error("A beta grant needs a usable expiry");
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });

  // **Checked rather than left to the foreign key.** A missing account is an
  // operator typing the wrong id, and that should come back as an answer, not
  // as a constraint violation to be interpreted.
  if (user === null) {
    return { granted: false, reason: "unknown-user" };
  }

  const existing = await prisma.subscription.findUnique({
    where: { userId },
    select: EXISTING_SELECT,
  });

  if (existing !== null) {
    return isSameGrant(existing, expiresAt)
      ? { granted: true, created: false }
      : { granted: false, reason: "already-entitled" };
  }

  try {
    await prisma.subscription.create({
      data: { userId, ...BETA_GRANT, expiresAt },
    });

    return { granted: true, created: true };
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
  }

  // Something wrote an entitlement between the read and the create. Whatever it
  // is, it is now what the account has — so it is judged exactly as it would
  // have been above, and left alone unless it is already this grant.
  const raced = await prisma.subscription.findUnique({
    where: { userId },
    select: EXISTING_SELECT,
  });

  if (raced !== null && isSameGrant(raced, expiresAt)) {
    return { granted: true, created: false };
  }

  return { granted: false, reason: "already-entitled" };
}
