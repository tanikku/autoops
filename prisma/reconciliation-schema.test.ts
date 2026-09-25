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
   * **The expand migration did not create the final identity**; the bridge
   * that followed it did, once both legacy columns could be left null. Kept as
   * a statement about *this* migration rather than about the schema.
   */
  it("the expand migration does not create the reconciliation identity", () => {
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

/**
 * The bridge that lets both writers exist at once.
 *
 * **The blocker it removes.** `applyBillingEvent` writes a delivery id and the
 * provider's own timestamp; reconciliation has neither — a run can answer
 * several notifications, or none at all on a sweep, so naming one delivery as
 * the cause would invent a causal claim, and inventing a value for a column
 * inside a unique index would invent an idempotency identity with it. While
 * those columns were `NOT NULL` there was no truthful row to write, so the
 * reconciliation writer could not exist.
 *
 * **Nulls being distinct is what makes the two constraints coexist**, and that
 * was measured against PostgreSQL 18 rather than assumed: legacy rows keep
 * being refused a twin, reconciliation rows leave `providerEventId` null
 * without colliding with each other, and a run is still stopped from writing
 * the same kind twice.
 */
const BRIDGE =
  "prisma/migrations/20260925180000_relax_billing_event_legacy_fields/migration.sql";

const bridge = readFileSync(BRIDGE, "utf8");

describe("the bridge migration", () => {
  it.each([
    ["DROP TABLE"],
    ["DROP COLUMN"],
    ["DROP INDEX"],
    ["DROP CONSTRAINT"],
    ["TRUNCATE"],
  ])("contains no %s", (statement) => {
    expect(bridge.toUpperCase()).not.toContain(statement);
  });

  it("rewrites no existing row", () => {
    expect(bridge).not.toMatch(/^[\t ]*UPDATE\b/m);
    expect(bridge).not.toMatch(/^[\t ]*DELETE\b/m);
    expect(bridge).not.toMatch(/^[\t ]*INSERT\b/m);
  });

  it("relaxes exactly the two legacy columns", () => {
    expect(bridge).toContain(
      'ALTER TABLE "BillingEvent" ALTER COLUMN "providerEventId" DROP NOT NULL',
    );
    expect(bridge).toContain('ALTER COLUMN "occurredAt" DROP NOT NULL');
    expect(bridge.match(/DROP NOT NULL/g)).toHaveLength(2);
  });

  it("creates the reconciliation identity and nothing else", () => {
    expect(bridge).toContain(
      'CREATE UNIQUE INDEX "BillingEvent_reconciliationRunId_kind_key" ON "BillingEvent"("reconciliationRunId", "kind")',
    );
    expect(bridge.match(/^CREATE UNIQUE INDEX/gm)).toHaveLength(1);
    expect(bridge.match(/^CREATE INDEX/gm)).toBeNull();
    expect(bridge.match(/^CREATE TABLE/gm)).toBeNull();
  });

  /** One table's worth of change, so nothing unrelated can ride along. */
  it("touches only BillingEvent", () => {
    const tables = new Set(
      [...bridge.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]),
    );

    expect([...tables]).toEqual(["BillingEvent"]);
  });
});

describe("what the bridge leaves the schema saying", () => {
  it.each([
    ["providerEventId", /providerEventId\s+String\?/],
    ["occurredAt", /occurredAt\s+DateTime\?/],
  ])("BillingEvent.%s is now optional", (_name, pattern) => {
    expect(model("BillingEvent")).toMatch(pattern);
  });

  /** Neither column is dropped: the legacy writer still fills both. */
  it.each(["providerEventId", "occurredAt"])("%s still exists", (column) => {
    expect(model("BillingEvent")).toContain(column);
  });

  it("keeps the legacy delivery constraint", () => {
    expect(model("BillingEvent")).toContain(
      "@@unique([provider, providerEventId])",
    );
  });

  it("adds the reconciliation identity", () => {
    expect(model("BillingEvent")).toContain(
      "@@unique([reconciliationRunId, kind])",
    );
  });

  /** The columns the reconciliation writer fills stay as the expand left them. */
  it.each([
    ["observedAt", /observedAt\s+DateTime\?/],
    ["reconciliationRunId", /reconciliationRunId\s+String\?/],
  ])("%s is unchanged by the bridge", (_name, pattern) => {
    expect(model("BillingEvent")).toMatch(pattern);
  });

  /** Untouched by this phase, and due to be removed in the contract one. */
  it("leaves Subscription alone", () => {
    expect(model("Subscription")).toMatch(/providerUpdatedAt\s+DateTime\?/);
    expect(model("Subscription")).toMatch(/providerSyncedAt\s+DateTime\?/);
    expect(bridge).not.toContain("Subscription");
  });
});

describe("the legacy writer is untouched", () => {
  const transition = readFileSync("lib/billing/transition.ts", "utf8");

  /**
   * **Nullable columns accept non-null values**, so relaxing them needed no
   * change here — which is the whole reason the bridge is safe to deploy ahead
   * of the new writer.
   */
  it.each(["providerEventId", "occurredAt"])("still writes %s", (column) => {
    expect(transition).toContain(column);
  });

  it("still writes neither of the reconciliation columns", () => {
    expect(transition).not.toContain("reconciliationRunId");
    expect(transition).not.toContain("observedAt");
  });
});
