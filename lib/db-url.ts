/**
 * Where the database is.
 *
 * **Both readers come through here.** `schema.prisma` carries no `url` at all —
 * Prisma 7 rejects the schema outright if it finds one (`P1012`) — so the CLI
 * takes it from `prisma.config.ts` and the application from `lib/prisma.ts`,
 * and each of those imports this module.
 *
 * `DATABASE_URL` is the answer wherever it is set, which is everywhere the app
 * is hosted. The fallback below only covers a local checkout with
 * `compose.yaml` running, where requiring the variable would mean every
 * developer setting the same value by hand.
 *
 * The fallback matches `compose.yaml`. Changing the port or credentials there
 * means changing them here too — a small duplication, kept because the
 * alternative is a `.env` file that has to exist before anything runs.
 */
const LOCAL_DEVELOPMENT_URL =
  "postgresql://autoops:autoops@localhost:5433/autoops";

export const databaseUrl = process.env.DATABASE_URL ?? LOCAL_DEVELOPMENT_URL;
