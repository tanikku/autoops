import path from "path";

// The MVP always uses the local SQLite file, addressed by absolute path.
// A relative path would resolve against the schema directory for the Prisma CLI
// but against the working directory at runtime, pointing them at two different
// databases.
export const databaseUrl = `file:${path.join(
  process.cwd(),
  "prisma",
  "dev.db",
)}`;
