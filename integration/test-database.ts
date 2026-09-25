/**
 * Where an integration test is allowed to write.
 *
 * **A separate variable, and no fallback.** `DATABASE_URL` is set wherever the
 * application runs, which is exactly the set of places these tests must never
 * touch: a harness that quietly used it would do real damage the first time
 * somebody ran it with a production shell open. So the only accepted source is
 * `BILLING_TEST_DATABASE_URL`, and its absence stops the run rather than
 * selecting a default.
 *
 * **The variable's name is not the safety.** Anybody can point it anywhere, so
 * the URL itself is inspected below. The checks are deliberately conservative:
 * they refuse far more than they need to, because the cost of a false refusal
 * is a developer reading one sentence, and the cost of a false accept is a
 * billing table full of synthetic rows in production.
 */

/** Hosts that belong to somebody's hosted database, never a disposable one. */
const HOSTED_MARKERS = [
  "railway.internal",
  "rlwy.net",
  "railway.app",
  "amazonaws.com",
  "neon.tech",
  "supabase.co",
  "azure.com",
  "cloudsql",
  "render.com",
  "heroku",
] as const;

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"] as const;

export class UnsafeTestDatabaseError extends Error {
  constructor(detail: string) {
    super(
      `Refusing to run billing integration tests: ${detail}. ` +
        "Point BILLING_TEST_DATABASE_URL at a disposable PostgreSQL whose " +
        "database name contains \"test\" — see integration/README.md.",
    );
    this.name = "UnsafeTestDatabaseError";
  }
}

/**
 * The URL these tests may write to, or an explanation of why there isn't one.
 *
 * Throws rather than returning null: every caller's only sensible response is
 * to stop, and a null would have to be checked at each of them.
 */
export function requireTestDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env.BILLING_TEST_DATABASE_URL;

  if (raw === undefined || raw.trim() === "") {
    throw new UnsafeTestDatabaseError(
      "BILLING_TEST_DATABASE_URL is not set (DATABASE_URL is deliberately not used)",
    );
  }

  assertDisposableDatabase(raw);

  return raw;
}

/**
 * Whether a URL describes a database that may be written to and thrown away.
 *
 * **Two independent signals, both required to be satisfiable.** A hosted
 * provider's hostname is refused outright, whatever the database is called;
 * and what remains must still say it is for testing, either by living on this
 * machine or by being named so. Neither check alone is enough — a disposable
 * container can sit behind any hostname, and "test" appears in plenty of names
 * that are somebody's real data.
 */
export function assertDisposableDatabase(url: string): void {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    // The URL is not echoed back: it carries a password.
    throw new UnsafeTestDatabaseError("the supplied URL could not be parsed");
  }

  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new UnsafeTestDatabaseError("the URL is not a PostgreSQL connection");
  }

  const host = parsed.hostname.toLowerCase();

  for (const marker of HOSTED_MARKERS) {
    if (host.includes(marker)) {
      throw new UnsafeTestDatabaseError(
        `the host looks like a hosted database (${marker})`,
      );
    }
  }

  // `pathname` is "/name"; a URL with no database at all leaves it empty.
  const database = parsed.pathname.replace(/^\//, "").toLowerCase();

  if (database === "") {
    throw new UnsafeTestDatabaseError("the URL names no database");
  }

  const onThisMachine = (LOOPBACK_HOSTS as readonly string[]).includes(host);
  const namedForTesting = database.includes("test");

  if (!onThisMachine && !namedForTesting) {
    throw new UnsafeTestDatabaseError(
      `the database "${database}" is neither on this machine nor named for testing`,
    );
  }
}
