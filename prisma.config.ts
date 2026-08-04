import { defineConfig } from "prisma/config";
import { databaseUrl } from "./lib/db-url";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Prisma 7 rejects `url` in the schema file: the CLI takes it from here and
    // the client takes it from its adapter. Both read `lib/db-url.ts`, so a
    // fresh checkout with `compose.yaml` running needs no environment variable
    // set before `prisma migrate` will work.
    url: databaseUrl,
  },
});
