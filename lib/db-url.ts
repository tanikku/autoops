/**
 * Where the database is.
 *
 * `DATABASE_URL` is the answer everywhere it is set — hosting platforms inject
 * it, and `schema.prisma` reads it directly through `env()`. This module only
 * covers the case where it is not: a local checkout with `compose.yaml`
 * running, where requiring the variable would mean every developer setting the
 * same value by hand.
 *
 * The fallback matches `compose.yaml`. Changing the port or credentials there
 * means changing them here too — a small duplication, kept because the
 * alternative is a `.env` file that has to exist before anything runs.
 */
const LOCAL_DEVELOPMENT_URL =
  "postgresql://autoops:autoops@localhost:5433/autoops";

export const databaseUrl = process.env.DATABASE_URL ?? LOCAL_DEVELOPMENT_URL;
