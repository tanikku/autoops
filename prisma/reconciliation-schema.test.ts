import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * What the reconciliation foundation's schema and its migration promise.
 *
 * **This is the expand half of an expand/contract change**, and what makes it
 * safe is everything it does *not* do. The old billing columns and the old
 * constraint have to survive it, because the code that writes them is still
 * running; mapping that code onto the new columns would give them a meaning
 * they do not have — `providerEventId` is not a reconciliation run, and saying
 * so in a migration would be worse than leaving both columns in place for one
 * release. Most of the assertions below exist to hold that line.
 *
 * **Read off the files rather than a database**, following
 * `billing-schema.test.ts`: `pnpm test` must not need PostgreSQL. That the
 * migration applies cleanly was measured separately, against a disposable
 * PostgreSQL 18 matching Production's version — these do not prove it.
 */

const MIGRATION =
  "prisma/migrations/20260925120000_add_reconciliation_foundation/migration.sql";

const sql = readFileSync(MIGRATION, "utf8");
const schema = readFileSync("prisma/schema.prisma", "utf8");

/** One model's block, from its declaration to the closing brace. */
function model(name: string): string {
  const match = new RegExp(`^model ${name} \\{[\\s\\S]*?^\\}`, "m").exec(schema);

  expect(match, `model ${name} is missing`).not.toBeNull();

  return match?.[0] ?? "";
}

describe("the migration changes nothing that already exists", () => {
  /**
   * **The whole safety argument of an expand phase.** A drop here would take
   * away a column the running code still writes, between the migration and the
   * deploy that stops writing it.
   */
  it.each([
    ["DROP TABLE"],
    ["DROP COLUMN"],
    ["DROP INDEX"],
    ["DROP CONSTRAINT"],
    ["TRUNCATE"],
    ["ALTER COLUMN"],
    ["RENAME"],
  ])("contains no %s", (statement) => {
    expect(sql.toUpperCase()).not.toContain(statement);
  });

  /**
   * **`ON UPDATE CASCADE` is not a statement.** Matching the bare word would
   * flag the two new foreign keys, so the check is anchored to a line's start —
   * the same distinction `billing-schema.test.ts` draws for its backfill.
   */
  it("rewrites no existing row", () => {
    expect(sql).not.toMatch(/^[\t ]*UPDATE\b/m);
    expect(sql).not.toMatch(/^[\t ]*DELETE\b/m);
    expect(sql).not.toMatch(/^[\t ]*INSERT\b/m);
  });

  /** Proof the guard above can still see the word it is anchored against. */
  it("does carry the cascade clauses that word appears in", () => {
    expect(sql).toContain("ON UPDATE CASCADE");
  });

  it("adds exactly two tables", () => {
    expect(sql.match(/^CREATE TABLE/gm)).toHaveLength(2);
  });

  it("adds exactly three columns to existing tables", () => {
    expect(sql.match(/ADD COLUMN/g)).toHaveLength(3);
  });
});

describe("what the old billing columns still are", () => {
  /**
   * **Kept deliberately, not forgotten.** `applyBillingEvent` still writes
   * both, and will until the reconciliation writer replaces it. The contract
   * migration removes them once nothing writes them.
   */
  it.each([
    ["providerEventId", /providerEventId\s+String\b/],
    ["occurredAt", /occurredAt\s+DateTime\b/],
  ])("BillingEvent keeps %s", (_name, pattern) => {
    expect(model("BillingEvent")).toMatch(pattern);
  });

  it("BillingEvent keeps its original unique constraint", () => {
    expect(model("BillingEvent")).toContain(
      "@@unique([provider, providerEventId])",
    );
  });

  /**
   * **The final identity, deliberately not created yet.** `reconciliationRunId`
   * is nullable in this phase and no writer sets it, so a unique constraint
   * over it would be a constraint over nulls — true of every row and therefore
   * saying nothing.
   */
  it("BillingEvent does not yet carry the reconciliation identity", () => {
    expect(model("BillingEvent")).not.toContain(
      "@@unique([reconciliationRunId, kind])",
    );
    expect(sql).not.toMatch(/reconciliationRunId[^)]*kind/);
  });

  it("Subscription keeps providerUpdatedAt", () => {
    expect(model("Subscription")).toMatch(/providerUpdatedAt\s+DateTime\?/);
  });
});

describe("what the migration adds to existing tables", () => {
  it.each([
    ["BillingEvent", "observedAt", 'ADD COLUMN     "observedAt" TIMESTAMP(3)'],
    [
      "BillingEvent",
      "reconciliationRunId",
      'ADD COLUMN     "reconciliationRunId" TEXT',
    ],
    [
      "Subscription",
      "providerSyncedAt",
      'ADD COLUMN     "providerSyncedAt" TIMESTAMP(3)',
    ],
  ])("%s gains %s", (_table, _column, statement) => {
    expect(sql).toContain(statement);
  });

  /**
   * **Nullable, because the old writer knows nothing about them.** A `NOT NULL`
   * here would fail the moment `applyBillingEvent` wrote a row, and a default
   * would invent a value that means something it does not.
   */
  it.each([
    ["observedAt", /observedAt\s+DateTime\?/],
    ["reconciliationRunId", /reconciliationRunId\s+String\?/],
  ])("BillingEvent.%s is optional in this phase", (_name, pattern) => {
    expect(model("BillingEvent")).toMatch(pattern);
  });

  it("Subscription.providerSyncedAt is optional", () => {
    expect(model("Subscription")).toMatch(/providerSyncedAt\s+DateTime\?/);
  });

  it.each(["observedAt", "reconciliationRunId", "providerSyncedAt"])(
    "%s is added without a default",
    (column) => {
      expect(sql).not.toMatch(
        new RegExp(`"${column}"[^;,]*DEFAULT`, "i"),
      );
      expect(sql).not.toMatch(new RegExp(`"${column}"[^;,]*NOT NULL`, "i"));
    },
  );
});

describe("the receipt table", () => {
  it("is created", () => {
    expect(sql).toContain('CREATE TABLE "ProviderEventReceipt"');
  });

  /**
   * **Delivery idempotency, as a constraint.** A provider resending the same
   * notification must fail the insert rather than be answered a second time.
   */
  it("makes one delivery recordable exactly once per provider", () => {
    expect(model("ProviderEventReceipt")).toContain(
      "@@unique([provider, providerEventId])",
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "ProviderEventReceipt_provider_providerEventId_key" ON "ProviderEventReceipt"("provider", "providerEventId")',
    );
  });

  it.each([
    ["@@index([provider, providerSubscriptionId, resolvedAt])"],
    ["@@index([resolvedAt, receivedAt])"],
    ["@@index([userId, receivedAt])"],
  ])("declares %s", (index) => {
    expect(model("ProviderEventReceipt")).toContain(index);
  });

  /**
   * **The account is optional, and that is the point.** A notification whose
   * account cannot be resolved is exactly the one somebody needs to find.
   */
  it("records a notification even when its account is unknown", () => {
    expect(model("ProviderEventReceipt")).toMatch(/userId\s+String\?/);
    expect(sql).toContain("ON DELETE SET NULL");
  });

  /**
   * **Nothing that could carry a payment instrument or a person.** The
   * provider's own object is never stored; what is kept is identifiers and an
   * outcome.
   */
  it.each(["payload", "body", "raw", "email", "card", "secret", "signature"])(
    "has no %s column",
    (forbidden) => {
      expect(model("ProviderEventReceipt").toLowerCase()).not.toMatch(
        new RegExp(`^\\s+\\w*${forbidden}\\w*\\s+\\w`, "m"),
      );
    },
  );
});

describe("the reconciliation table", () => {
  it("is created", () => {
    expect(sql).toContain('CREATE TABLE "BillingReconciliation"');
  });

  /**
   * **One row per provider subscription.** The lease has nothing to serialise
   * against if a second row can describe the same subscription.
   */
  it("serialises one provider subscription", () => {
    expect(model("BillingReconciliation")).toContain(
      "@@unique([provider, providerSubscriptionId])",
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "BillingReconciliation_provider_providerSubscriptionId_key" ON "BillingReconciliation"("provider", "providerSubscriptionId")',
    );
  });

  it.each([["@@index([pendingSince])"], ["@@index([leaseUntil])"]])(
    "declares %s",
    (index) => {
      expect(model("BillingReconciliation")).toContain(index);
    },
  );

  /** The lease and its fence, which is what orders two concurrent fetches. */
  it.each([
    ["leaseToken", /leaseToken\s+String\?/],
    ["leaseUntil", /leaseUntil\s+DateTime\?/],
    ["attempts", /attempts\s+Int\s+@default\(0\)/],
    ["pendingSince", /pendingSince\s+DateTime\?/],
    ["unpaidFirstSeenRunId", /unpaidFirstSeenRunId\s+String\?/],
  ])("carries %s", (_name, pattern) => {
    expect(model("BillingReconciliation")).toMatch(pattern);
  });
});

describe("nothing reads the new columns yet", () => {
  /**
   * **The expand phase is dormant by definition.** If a writer appeared here,
   * the contract phase's precondition — that no legacy writer remains — would
   * be being decided by accident rather than on purpose.
   */
  it.each(["reconciliationRunId", "providerSyncedAt", "observedAt"])(
    "%s has no writer in lib/",
    (column) => {
      const transition = readFileSync("lib/billing/transition.ts", "utf8");

      expect(transition).not.toContain(column);
    },
  );
});
