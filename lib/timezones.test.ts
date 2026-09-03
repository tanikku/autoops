import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isSupportedTimezone,
  NEW_ACCOUNT_TIMEZONE,
  supportedTimezones,
} from "@/lib/timezones";

/**
 * What a brand-new account's clock reads, and the one place that decides it.
 *
 * The zone a new row gets comes from `User.timezone`'s column default, which
 * no TypeScript test can observe: `ensureUser` omits the field, so the value
 * is chosen by PostgreSQL. What *can* be fixed here is that the schema still
 * declares the default this release intends, that the migration history moves
 * the column to it, and that the constant the application falls back to before
 * the row exists says the same thing.
 *
 * **The schema is read as a file on purpose.** It is the artefact that becomes
 * the DDL, and asserting on the generated client instead would only prove
 * Prisma copied whatever the schema happened to say.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const schema = readFileSync(`${repoRoot}prisma/schema.prisma`, "utf8");

/** The `@default(...)` on `User.timezone`, read out of the schema text. */
function declaredUserTimezoneDefault(): string {
  const model = /^model User \{$([\s\S]*?)^\}$/m.exec(schema);
  expect(model?.[1]).toBeTypeOf("string");

  const declared = /^\s*timezone\s+String\s+@default\("([^"]*)"\)\s*$/m.exec(
    model![1],
  );
  expect(declared?.[1]).toBeTypeOf("string");

  return declared![1];
}

describe("the zone a new account starts on", () => {
  it("is Asia/Tokyo, where the Closed Beta's users are", () => {
    expect(NEW_ACCOUNT_TIMEZONE).toBe("Asia/Tokyo");
  });

  /**
   * The pairing this checkpoint exists to hold. The column decides the row and
   * the constant decides what the hire form quotes before the row is written;
   * if they drift, a first-time user is told one zone and scheduled in another.
   */
  it("is what the schema gives a row that does not name one", () => {
    expect(declaredUserTimezoneDefault()).toBe(NEW_ACCOUNT_TIMEZONE);
  });

  it("is a zone the selector can offer, so it survives a round trip", () => {
    expect(isSupportedTimezone(NEW_ACCOUNT_TIMEZONE)).toBe(true);
    expect(supportedTimezones.map((zone) => zone.value)).toContain(
      NEW_ACCOUNT_TIMEZONE,
    );
  });

  /**
   * **Changing the default did not drop UTC.** An account that wants UTC — and
   * every existing account already on it — must keep being able to select it,
   * which is the difference between changing an initial value and changing
   * what the product supports.
   */
  it("leaves UTC selectable", () => {
    expect(isSupportedTimezone("UTC")).toBe(true);
    expect(supportedTimezones.map((zone) => zone.value)).toContain("UTC");
  });

  it("does not make every zone acceptable", () => {
    expect(isSupportedTimezone("Mars/Olympus")).toBe(false);
    expect(isSupportedTimezone("")).toBe(false);
    expect(isSupportedTimezone("Asia/Tokyo ")).toBe(false);
  });
});

/**
 * **The migration is the half that reaches production.** Editing
 * `schema.prisma` alone leaves the deployed column on its old default, because
 * `prisma migrate deploy` applies files and nothing else. These read the
 * committed SQL rather than a database, which is all that can be checked
 * without one — and enough to catch the schema and the history disagreeing.
 */
describe("the migration that moves the column", () => {
  const sql = readFileSync(
    `${repoRoot}prisma/migrations/20260903150000_default_user_timezone_asia_tokyo/migration.sql`,
    "utf8",
  );

  it("sets the column default to the declared zone", () => {
    expect(sql).toContain(
      `ALTER TABLE "User" ALTER COLUMN "timezone" SET DEFAULT '${NEW_ACCOUNT_TIMEZONE}';`,
    );
  });

  /**
   * **The prohibition this checkpoint was written around.** A row already
   * carrying `UTC` may have taken the old default or may have been chosen
   * deliberately, and nothing stored distinguishes them, so rewriting them is
   * not a safe guess. Any statement that touches existing rows fails here.
   */
  it("rewrites no existing row", () => {
    const statements = sql
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("--"));

    expect(statements).toEqual([
      `ALTER TABLE "User" ALTER COLUMN "timezone" SET DEFAULT '${NEW_ACCOUNT_TIMEZONE}';`,
    ]);

    for (const forbidden of ["UPDATE", "INSERT", "DELETE", "TRUNCATE"]) {
      expect(sql.toUpperCase()).not.toContain(forbidden);
    }
  });
});
