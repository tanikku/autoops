import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";

/**
 * Turns the operational runner into something the Production image can run.
 *
 * **Why an artifact exists at all.** The runner is TypeScript, and the deployed
 * image has no TypeScript runtime: `tsx` is a development dependency and is
 * pruned before the image is finished. The image does have Node, the repository
 * sources and the production `node_modules`, so the smallest thing that closes
 * the gap is one compiled entrypoint.
 *
 * **Why it is compiled rather than reached another way.** The database is only
 * addressable from inside Railway's private network, so the command has to run
 * in the container. Reaching it from a laptop would mean giving PostgreSQL a
 * public address, which is a permanent hole opened for an occasional errand.
 *
 * **Bundled, but only the repository's own code.** Everything that arrives
 * through `node_modules` stays there and is imported at runtime: the Prisma
 * client's runtime, its driver adapter and `pg` are production dependencies and
 * are already in the image. Copying them into a bundle would make a second copy
 * that could disagree with the one the application uses.
 */

const require = createRequire(import.meta.url);

/**
 * What `server-only` means when the importer is a command rather than a page.
 *
 * **The marker stays on the modules that carry it.** `lib/billing/admin.ts` and
 * `lib/prisma.ts` still say they are server-only, and every application import
 * of them is still checked. What changes here is only how that package resolves
 * for this one build: to the same empty module Next.js resolves it to under the
 * `react-server` condition.
 *
 * **Doing it at build time is what keeps the run command plain.** The
 * alternative is `node --conditions=react-server`, which works but puts a flag
 * an operator can forget in front of a command that writes to Production.
 */
// Derived from the package's own location rather than a path spelled out here:
// `empty.js` is a file the package ships but does not export, so it can be
// found beside the entry it does export and cannot be asked for by name.
const serverOnlyEmptyModule = path.join(
  path.dirname(require.resolve("server-only")),
  "empty.js",
);

/**
 * Leaves everything that comes from `node_modules` as a runtime import.
 *
 * **Written out rather than switched on**, because esbuild's own
 * `packages: "external"` treats anything that is not a relative path as a
 * package — including this repository's `@/` alias. A mistyped `@/lib/...`
 * would then be externalised instead of refused, the build would pass, and the
 * artifact would fail at run time in front of whoever was running it. Sending
 * `@/` back for ordinary resolution is what makes a missing module a build
 * error again.
 *
 * The artifact sits at `dist/ops/`, so Node resolves the externals upward to
 * `/app/node_modules` exactly as the application does.
 */
const externaliseInstalledPackages = {
  name: "externalise-installed-packages",
  setup(build) {
    // Anything not beginning with `.` or `/`: a bare specifier, or the alias.
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      // The repository's own alias. Sent back for ordinary resolution so a
      // module that does not exist is an error rather than an external.
      if (args.path.startsWith("@/")) {
        return null;
      }

      // **Answered here rather than left to `alias`**, which esbuild applies
      // after a plugin has spoken. Externalising it would put a throwing
      // module in front of a command that has to run outside a request.
      if (args.path === "server-only") {
        return { path: serverOnlyEmptyModule };
      }

      return { path: args.path, external: true };
    });
  },
};

// Cleared first so a build can be repeated without an earlier artifact
// surviving a compilation that would no longer produce it.
rmSync("dist/ops", { recursive: true, force: true });

await build({
  entryPoints: ["scripts/grant-beta.ts"],
  outfile: "dist/ops/grant-beta.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  // The image runs Node 22; building for anything newer would compile syntax it
  // cannot parse, and the failure would arrive at run time.
  target: "node22",
  plugins: [externaliseInstalledPackages],
  // `@/` is the repository's own alias, and it has to mean here what it means
  // everywhere else.
  tsconfig: "tsconfig.json",
  // Readable in a stack trace. This is an operator's tool, not a payload to
  // make small.
  minify: false,
  sourcemap: false,
  // **Fails the build rather than warning.** A runner that could not be
  // compiled must not reach an image where somebody would discover it by
  // running it.
  logLevel: "warning",
});

console.log("built dist/ops/grant-beta.mjs");
