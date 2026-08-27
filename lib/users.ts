import "server-only";

import { DEFAULT_TIMEZONE } from "@/lib/datetime";
import {
  DEFAULT_LANGUAGE,
  isSupportedLanguage,
  type Language,
} from "@/lib/i18n";
import { prisma } from "@/lib/prisma";

/**
 * The zone the signed-in user's timestamps are rendered in.
 *
 * Read from the database rather than carried in the session: the JWT is issued
 * at sign-in and would keep serving the old value until the next one, so a
 * changed setting would appear to do nothing.
 *
 * Falls back to UTC for a user whose row does not exist yet — nothing writes
 * it until a write path provisions it (`requireProvisionedUserId`), so a fresh
 * account can reach the dashboard before the row does. **Reading must not be
 * what creates it**, which is why the fallback is here rather than a write.
 */
export async function getUserTimezone(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });

  return user?.timezone ?? DEFAULT_TIMEZONE;
}

/**
 * The language AutoOps renders its own screens in for this user.
 *
 * Read from the database for the same reason the zone is: the JWT is issued at
 * sign-in and would keep serving the old value, so a changed setting would
 * appear to do nothing until the next one.
 *
 * **Falls back twice, and neither fallback writes.** A user whose row does not
 * exist yet gets English — a read must not be what creates the row — and so
 * does a stored value this version cannot read, which is what keeps a language
 * removed in a later release from turning a dashboard into a blank page.
 */
export async function getUserLanguage(userId: string): Promise<Language> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { language: true },
  });

  return user && isSupportedLanguage(user.language)
    ? user.language
    : DEFAULT_LANGUAGE;
}

/**
 * Changes the language AutoOps speaks to this user in.
 *
 * Touches that column and nothing else, for the same reason `setUserTimezone`
 * does. **The row is not created here** — a caller reaching this has been
 * through the provisioning boundary, which is what guarantees there is
 * something to update.
 *
 * **It changes no worker.** Instructions, watched pages, schedules and stored
 * output are the owner's own material; this decides only which words the
 * product uses about them.
 */
export async function setUserLanguage(
  userId: string,
  language: Language,
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { language },
  });
}

/**
 * Changes the zone a user's timestamps are read and scheduled in.
 *
 * Touches that column and nothing else: the rest of the row comes from the
 * provider and is refreshed by `ensureUser` at the provisioning boundary
 * (`requireProvisionedUserId`), so writing it here would only risk overwriting
 * something newer with something staler.
 *
 * **The row is not created here.** A caller reaching this has been through
 * that boundary, which is what guarantees there is something to update.
 */
export async function setUserTimezone(
  userId: string,
  timezone: string,
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { timezone },
  });
}

/**
 * Writes the signed-in account to the database if it is not there yet, and
 * refreshes what the provider knows about it if it is.
 *
 * Sessions are JWT-only (no Prisma adapter), so nothing creates the row at
 * sign-in — and **this is not called at sign-in either**. It runs at the
 * provisioning boundary (`requireProvisionedUserId`), which the write paths
 * that need the row go through: creating a worker, saving a timezone, and
 * spending an AI draft from the account's allowance.
 *
 * **The row is needed for two different reasons, and only one of them is a
 * foreign key.** A `Routine` points at it — and so does a `RateLimitBucket` —
 * so it has to exist before the first of either is written; the account's own
 * settings also live on it, so it has to exist before one of those can be
 * changed. A comment naming only the first is how the second went unnoticed
 * until an account with no worker could not save its timezone.
 *
 * **`timezone` is not touched.** Every other column here comes from the
 * provider and is safe to overwrite with a newer copy of itself; that one is
 * the account's own choice, and refreshing a profile must not undo it.
 */
export async function ensureUser(user: {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
}): Promise<void> {
  const fields = {
    email: user.email,
    name: user.name ?? null,
    image: user.image ?? null,
  };

  await prisma.user.upsert({
    where: { id: user.id },
    create: { id: user.id, ...fields },
    update: fields,
  });
}
