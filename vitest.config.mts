import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

/**
 * Teaches Vitest the one thing it cannot work out for itself: what `@/` means.
 *
 * The mapping lives in `tsconfig.json` for TypeScript and in the bundler for
 * Next.js, and neither of those is something Vitest reads. Restating it here
 * keeps `tsconfig.json` untouched and adds no plugin to keep the two in sync.
 *
 * **The trailing slash matters.** Aliasing bare `@` would also capture every
 * scoped package — `@prisma/client` would be rewritten to a path inside this
 * repository and fail to resolve.
 *
 * `.mts` rather than `.ts`: this file is ESM, and `package.json` declares no
 * `"type"`, so a `.ts` extension makes the loader parse it as CommonJS first.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@/": `${rootDir}/`,
    },
  },
});
