import { PrismaPg } from "@prisma/adapter-pg";
import type { Prisma } from "@/lib/generated/prisma/client";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { databaseUrl } from "@/lib/db-url";

/**
 * Something queries can be sent through: the client, or a transaction.
 *
 * **What it exists for is letting one repository function serve both.** A
 * helper that reaches for the module's client cannot be part of somebody's
 * transaction, so a caller wanting two writes to land together would have to
 * write the queries out itself — and then the repository boundary is only a
 * boundary until the first time it matters.
 *
 * The transaction client is the ordinary one minus the methods that make no
 * sense inside a transaction, so anything written against this works either
 * way round.
 */
export type DbClient = PrismaClient | Prisma.TransactionClient;

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient() {
  // Prisma 7 requires a driver adapter; `pg` is pure JavaScript, so unlike its
  // SQLite predecessor it needs no native build and no bundler exclusion.
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

// Reuse the client across hot reloads in development.
if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
