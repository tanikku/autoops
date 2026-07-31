import "server-only";

import { prisma } from "@/lib/prisma";

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
