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
 * Falls back to UTC for a user whose row does not exist yet — `ensureUser`
 * only writes it when the first worker is created, so a fresh account can
 * reach the dashboard before the row does.
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
 * provider and is refreshed by `ensureUser` at sign-in, so writing it here
 * would only risk overwriting something newer with something staler.
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
 * Writes the signed-in account to the database if it is not there yet.
 *
 * Sessions are JWT-only (no Prisma adapter), so nothing creates the row at
 * sign-in. Owned rows carry a foreign key to `User`, so the account has to
 * exist before the first one is written.
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
