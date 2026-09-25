import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

/**
 * The integration suite, which needs a real PostgreSQL.
 *
 * **A second config rather than a flag on the first.** `vitest.config.mts`
 * names no `include`, so it takes Vitest's default — every `*.test.ts` in the
 * repository. Anything these tests need would therefore have to be excluded
 * there, and an exclusion is the kind of line that gets tidied away by somebody
 * who does not know a database depends on it. Two configs and two filename
 * conventions say it out loud instead: `.test.ts` runs anywhere, and
 * `.integration.ts` runs only from here.
 *
 * The alias block is the same one `vitest.config.mts` explains at length — `@/`
 * for the repository root, and `server-only` neutralised the way Next.js does
 * under `react-server`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@/": `${rootDir}/`,
      "server-only": `${rootDir}/node_modules/server-only/empty.js`,
    },
  },
  test: {
    include: ["integration/**/*.integration.ts"],
    /**
     * One file at a time, in order.
     *
     * The cases share one database and delete each other's fixture rows
     * between them; running two files at once would make them race over
     * cleanup rather than over the unique index, which is the only race this
     * suite is meant to have.
     */
    fileParallelism: false,
    // Establishing a pool of connections and running ten rounds of a race
    // takes longer than a unit test's default allowance.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
