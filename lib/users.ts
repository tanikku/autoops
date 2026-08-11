import "server-only";

import { DEFAULT_TIMEZONE } from "@/lib/datetime";
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
 * that need the row go through: creating a worker, and saving a timezone.
 *
 * **The row is needed for two different reasons, and only one of them is a
 * foreign key.** A `Routine` points at it, so it has to exist before the first
 * one is written; the account's own settings also live on it, so it has to
 * exist before one of those can be changed. A comment naming only the first
 * is how the second went unnoticed until an account with no worker could not
 * save its timezone.
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
