import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * What the billing foundation's schema and its migration promise.
 *
 * **Read off the files rather than a database.** This deployment has no local
 * PostgreSQL to migrate against, and the properties worth fixing here are
 * textual ones: which constraint exists, which column is added, and — most
 * importantly — which rows the backfill touches and which it leaves alone.
 * Saying so plainly matters: these do not prove the migration applies cleanly,
 * which is what the deployment phase is for.
 *
 * **The backfill is the part that could go wrong quietly.** A `WHERE` clause
 * one condition short would mark accounts as having lost an offer they were
 * never given, and nothing afterwards would distinguish them.
 */

const MIGRATION =
  "prisma/migrations/20260924120000_add_billing_event_foundation/migration.sql";

const sql = readFileSync(MIGRATION, "utf8");
const schema = readFileSync("prisma/schema.prisma", "utf8");

/**
 * The one `UPDATE` statement, from its verb to its semicolon.
 *
 * Matched at the start of a line rather than anywhere: `ON UPDATE CASCADE`
 * inside the new foreign key contains the same word and is not a statement.
 */
function backfill(): string {
  const match = /^UPDATE\b[\s\S]*?;/m.exec(sql);

  expect(match).not.toBeNull();

  return match?.[0] ?? "";
}

describe("the column that records a forfeited trial", () => {
  it("is added to Subscription, nullable", () => {
    expect(sql).toContain(
      'ALTER TABLE "Subscription" ADD COLUMN     "trialForfeitedAt" TIMESTAMP(3);',
    );
  });

  /**
   * **Nullable with no default is the whole design.** An account that may still
   * be offered a trial has nothing recorded, which is a different statement
   * from "recorded as not forfeited".
   */
  it("has no default, so an ordinary account records nothing", () => {
    expect(sql).not.toMatch(/"trialForfeitedAt" TIMESTAMP\(3\)[^;]*DEFAULT/);
    expect(sql).not.toMatch(/"trialForfeitedAt" TIMESTAMP\(3\) NOT NULL/);
  });

  it("is declared in the schema as an optional timestamp", () => {
    expect(schema).toMatch(/trialForfeitedAt\s+DateTime\?/);
  });

  /** Two columns, two questions. Neither is renamed and neither is dropped. */
  it("leaves the existing trial columns exactly as they were", () => {
    for (const column of [
      "trialStartedAt",
      "trialEndsAt",
      "trialConsumedAt",
    ]) {
      expect(sql).not.toContain(`DROP COLUMN "${column}"`);
      expect(sql).not.toContain(`RENAME COLUMN "${column}"`);
      expect(schema).toMatch(new RegExp(`${column}\\s+DateTime\\?`));
    }
  });
});

describe("the backfill", () => {
  it("writes only the forfeit column", () => {
    expect(backfill()).toContain('SET "trialForfeitedAt" = "createdAt"');
  });

  /**
   * **The grant's own timestamp, not the migration's.** `createdAt` on these
   * rows is the instant the grant was written, which is exactly the instant the
   * account stopped being owed a trial. `now()` would record when this
   * migration ran — true of the migration, not of the account.
   */
  it("uses the grant's own time rather than the migration's", () => {
    const update = backfill();

    expect(update).toContain('"createdAt"');
    expect(update).not.toMatch(/now\(\)|CURRENT_TIMESTAMP/i);
  });

  /**
   * **Three conditions, and each one prevents a different mistake.** Without
   * `source`, a beta plan somebody bought would be marked. Without `plan`, every
   * admin-touched row would be. Without the null check, re-running would move a
   * date that already meant something.
   */
  it("touches only admin-granted beta rows that have no date yet", () => {
    const update = backfill();

    expect(update).toContain(`"plan" = 'beta'`);
    expect(update).toContain(`"source" = 'admin'`);
    expect(update).toContain(`"trialForfeitedAt" IS NULL`);
  });

  it("never writes the column that means a trial was consumed", () => {
    expect(backfill()).not.toContain("trialConsumedAt");
    expect(sql).not.toContain('SET "trialConsumedAt"');
  });

  /** A trial row is not a grant, and is not touched by plan or by source. */
  it("cannot match a trial row", () => {
    const update = backfill();

    expect(update).not.toContain(`'trial'`);
    // A trial's plan is `trial` and its source is `trial`; both conditions
    // above exclude it.
    expect(update).toContain(`"plan" = 'beta'`);
  });

  it("is the only row-writing statement in the migration", () => {
    const writes = sql.match(/^\s*(UPDATE|INSERT|DELETE)\b/gim) ?? [];

    expect(writes).toHaveLength(1);
  });
});

describe("what the migration is not allowed to do", () => {
  it("drops nothing and truncates nothing", () => {
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    // The only `DELETE` is the cascade clause on the new foreign key.
    const deletes = sql.match(/\bDELETE\b/gi) ?? [];
    expect(deletes).toHaveLength(1);
    expect(sql).toContain("ON DELETE CASCADE");
  });

  it("changes no table but Subscription and the new one", () => {
    const altered = [...sql.matchAll(/ALTER TABLE "(\w+)"/g)].map(
      (match) => match[1],
    );

    expect([...new Set(altered)].sort()).toEqual([
      "BillingEvent",
      "Subscription",
    ]);
  });

  it("creates only the billing event table", () => {
    const created = [...sql.matchAll(/CREATE TABLE "(\w+)"/g)].map(
      (match) => match[1],
    );

    expect(created).toEqual(["BillingEvent"]);
  });
});

/**
 * The table that makes a repeated provider callback harmless.
 *
 * **The constraint is the mechanism, not a convention.** A second delivery of
 * the same event cannot be written, so it cannot be processed twice — the same
 * shape `UsagePeriod` already uses for two simultaneous first uses.
 */
describe("the billing event table", () => {
  it("cannot hold the same event from the same provider twice", () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "BillingEvent_provider_providerEventId_key" ON "BillingEvent"("provider", "providerEventId");',
    );
    expect(schema).toMatch(/@@unique\(\[provider, providerEventId\]\)/);
  });

  /**
   * **Unique per provider, never globally.** Two providers may each number an
   * event `1`, and neither has any claim on the other's numbering — so the
   * constraint carries `provider` as well.
   */
  it("lets two providers reuse the same event id", () => {
    const unique = sql.match(
      /CREATE UNIQUE INDEX "BillingEvent_[^"]+" ON "BillingEvent"\(([^)]+)\)/,
    );

    expect(unique?.[1]).toContain('"provider"');
    expect(unique?.[1]).toContain('"providerEventId"');
  });

  it("carries the fields a repeated or late delivery needs", () => {
    for (const column of [
      "provider",
      "providerEventId",
      "userId",
      "kind",
      "occurredAt",
      "receivedAt",
    ]) {
      expect(sql).toContain(`"${column}"`);
    }
  });

  it("belongs to an account, and goes when the account does", () => {
    expect(sql).toContain(
      'ALTER TABLE "BillingEvent" ADD CONSTRAINT "BillingEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
    );
  });

  it("can be read as one account's history, in order", () => {
    expect(sql).toContain(
      'CREATE INDEX "BillingEvent_userId_occurredAt_idx" ON "BillingEvent"("userId", "occurredAt");',
    );
  });

  /** `kind` is one of Koqentra's own words, held as a string like `plan`. */
  it("holds its kind as a plain string rather than a database enum", () => {
    expect(sql).toContain('"kind" TEXT NOT NULL');
    expect(sql).not.toMatch(/CREATE TYPE/i);
  });

  /**
   * **No provider's vocabulary appears anywhere.** A column or a comment named
   * after one provider's payload is a column the next provider has to pretend
   * to have.
   */
  it("names no billing provider", () => {
    const model = schema.slice(schema.indexOf("model BillingEvent"));

    for (const name of [
      "stripe",
      "Stripe",
      "checkout.session",
      "customer.subscription",
      "invoice.payment",
      "app_store",
      "play_store",
    ]) {
      expect(sql).not.toContain(name);
    }

    // The schema's own comment may cite provider names as examples of the
    // column's values; what must not appear is a provider's event vocabulary.
    expect(model).not.toContain("checkout.session");
    expect(model).not.toContain("customer.subscription");
    expect(model).not.toContain("invoice.payment");
  });
});

/**
 * **The two event tables stay apart.** One records what a call to a model cost;
 * the other records what a billing provider said about an entitlement. They
 * share no question and no reader.
 */
describe("the cost telemetry table", () => {
  it("is left exactly as it was", () => {
    expect(sql).not.toContain("ProviderUsageEvent");
  });

  it("is still its own table in the schema", () => {
    expect(schema).toContain("model ProviderUsageEvent");
    expect(schema).toContain("model BillingEvent");
  });
});
