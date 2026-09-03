import "server-only";

import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { ensureUser } from "@/lib/users";

/**
 * The tenant key for the current request.
 *
 * The middleware already gates `/dashboard`, so this is a defence-in-depth
 * check: server actions and pages must never fall back to an unscoped query.
 *
 * **It reads and never writes.** Most callers are pages, and a page that
 * provisioned an account row would turn every render into a write. A caller
 * that needs the row to exist asks for it explicitly — see
 * `requireProvisionedUserId`.
 */
export async function requireUserId(): Promise<string> {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/");
  }

  return session.user.id;
}

/**
 * The account row could not be written, so the work that needed it cannot go
 * ahead.
 *
 * **Not an authentication failure.** Whoever asked is signed in and their
 * identity is known; what is missing is the row AutoOps keeps its own settings
 * in. Callers distinguish the two because a redirect travels as a thrown error
 * too, and swallowing that would leave a signed-out visitor looking at a
 * form error instead of the sign-in page.
 *
 * Deliberately the same minimal shape as `ExecutionSuppressedError` and
 * `RunPersistenceError`: one class, one predicate, no taxonomy.
 */
export class UserProvisioningError extends Error {
  constructor(userId: string, options?: { cause?: unknown }) {
    super(`Could not provision the account row for ${userId}.`, options);
    this.name = "UserProvisioningError";
  }
}

/** Whether a rejection means the account row could not be written. */
export function isUserProvisioningError(error: unknown): boolean {
  return error instanceof UserProvisioningError;
}

/**
 * The tenant key, with the account row guaranteed to exist behind it.
 *
 * **Sessions are JWT-only, so nothing writes the `User` row at sign-in.** That
 * is the cost of having no database adapter, and it is deliberate: `auth.ts`
 * stays free of database imports, which is what lets the middleware run on the
 * edge. The row is created lazily instead, and this is where.
 *
 * **Only write paths ask for it.** A read renders fine without the row —
 * `getUserTimezone` falls back to the column default — so provisioning on the
 * way in would make every page view a write for no gain. What actually needs
 * the row is a write: a `Routine` carries a foreign key to it, a
 * `RateLimitBucket` carries one too, and the account's own settings live on it.
 *
 * **Ask for it after deciding the work is going ahead.** A submission that
 * gets rejected must not create the row that saving it would have needed, so
 * validation comes first and this comes after.
 *
 * **An account with no email is stopped rather than invented.** `User.email`
 * is `NOT NULL` and unique, and a placeholder would be a fabricated identity
 * that the unique constraint then treats as real. A session missing it is
 * treated exactly as a session missing an id: send them back to sign in.
 */
export async function requireProvisionedUserId(): Promise<string> {
  const session = await auth();

  // `email` is as required as `id` here, for a reason that is not about
  // authentication: the column it lands in cannot be null.
  if (!session?.user?.id || !session.user.email) {
    redirect("/");
  }

  try {
    await ensureUser({
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      image: session.user.image,
    });
  } catch (error) {
    // Named so a caller can tell it apart from the redirect above, which also
    // leaves by being thrown. The driver's own complaint travels as `cause`
    // and stays in the log.
    throw new UserProvisioningError(session.user.id, { cause: error });
  }

  return session.user.id;
}
