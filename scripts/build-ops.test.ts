import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The compiled runner, checked as the thing an operator will actually run.
 *
 * **The source runner is tested elsewhere**, with its collaborators replaced —
 * see `grant-beta-runner.test.ts`, which is where the cohort rules live. What
 * is fixed here is narrower and different in kind: that a file exists, that
 * Node can run it without a TypeScript toolchain or an extra flag, and that it
 * still refuses the same commands the source does.
 *
 * **Nothing here reaches a database.** Every case below is refused while
 * reading the command, which is the one part of the artifact that can be
 * exercised without one.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const ARTIFACT = path.join(ROOT, "dist", "ops", "grant-beta.mjs");

const EXPIRY = "2026-12-31T23:59:59Z";

/** Runs the artifact the way an operator would, and reports how it ended. */
function runArtifact(args: string[]): { output: string; code: number } {
  try {
    const output = execFileSync(process.execPath, [ARTIFACT, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // **No DATABASE_URL.** Anything that reached a connection would hang or
      // fail slowly; everything asserted below stops long before that.
      env: { ...process.env, DATABASE_URL: "" },
    });

    return { output, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number };

    return {
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
      code: failure.status ?? 1,
    };
  }
}

beforeAll(() => {
  // Built from source rather than assumed: a stale artifact would let this file
  // pass while describing something that is no longer shipped.
  rmSync(path.join(ROOT, "dist", "ops"), { recursive: true, force: true });

  execFileSync(process.execPath, [path.join(ROOT, "scripts", "build-ops.mjs")], {
    cwd: ROOT,
    stdio: "ignore",
  });
}, 120_000);

describe("the artifact the image ships", () => {
  it("is produced by the ops build", () => {
    expect(existsSync(ARTIFACT)).toBe(true);
  });

  /**
   * **Only what the image already has.** Everything reached through
   * `node_modules` stays an import, and all four of these are production
   * dependencies or Node itself.
   */
  it("imports nothing the production image lacks", () => {
    const imports = [
      ...readFileSync(ARTIFACT, "utf8").matchAll(/from\s*"([^"]+)"/g),
    ]
      .map((match) => match[1])
      .filter((specifier) => !specifier.startsWith("."));

    expect([...new Set(imports)].sort()).toEqual([
      "@prisma/adapter-pg",
      "@prisma/client/runtime/client",
      "node:path",
      "node:url",
    ]);
  });

  /**
   * **The marker is resolved away for this build, not removed from the
   * source.** `lib/billing/admin.ts` still declares itself server-only; what
   * the bundle contains is the empty module that declaration resolves to.
   */
  it("carries no server-only import to trip over", () => {
    expect(readFileSync(ARTIFACT, "utf8")).not.toContain('"server-only"');
  });
});

/**
 * **Plain `node`, no flags.** Running it under the source toolchain needs
 * `--conditions=react-server`; needing that in front of a command that writes
 * to Production would be a flag somebody eventually forgets.
 */
describe("running it with nothing but node", () => {
  it.each([
    ["the expiry is missing", ["--expected-users=5"], "Missing --expires-at"],
    ["the count is missing", [`--expires-at=${EXPIRY}`], "Missing --expected-users"],
    [
      "the count is zero",
      ["--expected-users=0", `--expires-at=${EXPIRY}`],
      "positive whole number",
    ],
    [
      "the count is not a number",
      ["--expected-users=five", `--expires-at=${EXPIRY}`],
      "positive whole number",
    ],
    [
      "the expiry is not a timestamp",
      ["--expected-users=5", "--expires-at=whenever"],
      "not a usable timestamp",
    ],
    [
      "the expiry has already passed",
      ["--expected-users=5", "--expires-at=2026-01-01T00:00:00Z"],
      "must be in the future",
    ],
    [
      "an argument is not one this command has",
      ["--expected-users=5", `--expires-at=${EXPIRY}`, "--force"],
      "Unknown argument",
    ],
    [
      "the execute flag is misspelt",
      ["--expected-users=5", `--expires-at=${EXPIRY}`, "--exeucte"],
      "Unknown argument",
    ],
  ])("refuses when %s", (_label, args, expected) => {
    const { output, code } = runArtifact(args);

    expect(output).toContain(expected);
    expect(code).not.toBe(0);
  });

  /**
   * Every refusal above happens while reading the command, so none of them can
   * have written anything — there is nothing to connect to in this environment
   * and the artifact never tried.
   */
  it("refuses before it could reach a database", () => {
    const { output } = runArtifact(["--execute"]);

    expect(output).toContain("Missing --expected-users");
    expect(output).not.toContain("prisma");
    expect(output).not.toContain("postgres");
  });

  /** A transcript outlives the command; it may carry counts, never accounts. */
  it("names nobody when it refuses", () => {
    const { output } = runArtifact(["--expected-users=5", "--expires-at=nope"]);

    expect(output).not.toContain("google-sub");
    expect(output).not.toMatch(/@[\w.-]+\.\w+/);
  });
});
