import "server-only";

import { redirect } from "next/navigation";
import { auth } from "@/auth";
import {
  isAccountDeletedError,
  TombstoneUnverifiableError,
} from "@/lib/account-tombstone";
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
 * The account was deleted, so its row is never written again.
 *
 * **A provisioning failure as far as every existing caller knows**, so each of
 * them already stops before its write and shows what it shows when the row
 * could not be made. Its own class is what lets it be told apart from a
 * database that did not answer.
 *
 * **Names no subject.** The base message carries the id; this one replaces it,
 * because the id is what a deleted account must not leave in a log.
 */
export class DeletedAccountError extends UserProvisioningError {
  constructor(options?: { cause?: unknown }) {
    super("", options);
    this.name = "DeletedAccountError";
    this.message = "This account has been deleted and cannot be used again.";
  }
}

/** Whether a rejection means the account was deleted. */
export function isDeletedAccountError(error: unknown): boolean {
  return error instanceof DeletedAccountError;
}

/**
 * Whether the account was deleted could not be checked, so its row was not
 * written.
 *
 * **A provisioning failure to every existing caller, under the same name** —
 * the billing log classifies errors by name, and this one should read there as
 * the provisioning failure it is. It is not a deleted account
 * (`isDeletedAccountError` is false) and not a database failure either: it has
 * its own class.
 *
 * **Names no subject**, for the same reason as `DeletedAccountError`: the base
 * message carries the id, and this path is new.
 */
export class ProvisioningUnverifiableError extends UserProvisioningError {
  constructor(options?: { cause?: unknown }) {
    super("", options);
    this.message = "Whether this account was deleted could not be checked, so it was not provisioned.";
  }
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
    if (isAccountDeletedError(error)) {
      throw new DeletedAccountError({ cause: error });
    }

    if (error instanceof TombstoneUnverifiableError) {
      throw new ProvisioningUnverifiableError({ cause: error });
    }

    // Named so a caller can tell it apart from the redirect above, which also
    // leaves by being thrown. The driver's own complaint travels as `cause`
    // and stays in the log.
    throw new UserProvisioningError(session.user.id, { cause: error });
  }

  return session.user.id;
}
