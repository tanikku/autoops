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
/**
 * What Next.js resolves `server-only` to, restated for Vitest.
 *
 * The package exports two files and picks between them by condition: under
 * `react-server` it is `empty.js`, and under anything else it is `index.js`,
 * which throws on import. Next.js compiles server modules with that condition
 * set, so `import "server-only"` costs nothing there; Vitest does not, so the
 * seven modules carrying that line — the scheduler, dispatcher, queue and the
 * repositories — could not be imported by a test at all.
 *
 * **This points at the real `empty.js` rather than a stub of our own.** The
 * file it names is the one Next.js already uses, so the two cannot disagree
 * about what neutralising `server-only` means.
 */
const serverOnlyUnderReactServer = `${rootDir}/node_modules/server-only/empty.js`;

export default defineConfig({
  /**
   * Compiles the JSX in a page or component, which `tsconfig.json` does not.
   *
   * It says `"preserve"` because Next.js does the transform itself, with its
   * own runtime — correct for the build, and nothing at all for Vitest, which
   * hands `.tsx` to esbuild and gets JSX back out. Naming the automatic runtime
   * here is the whole of what a test needs to import a page: no renderer, no
   * DOM, no new dependency. React is already a dependency of the application.
   *
   * `oxc` rather than `esbuild`: Vite 8 transforms with oxc, and setting both
   * makes it say so and ignore the other one.
   */
  oxc: { jsx: { runtime: "automatic" } },

  resolve: {
    alias: {
      "@/": `${rootDir}/`,
      "server-only": serverOnlyUnderReactServer,
    },
  },
});
