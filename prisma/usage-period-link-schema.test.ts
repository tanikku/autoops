import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * What linking provider usage to usage periods promises, in the schema and in
 * its migration.
 *
 * **Read off the files rather than a database**, as the other schema suites
 * are: these fix what the migration says, not that it applies — the deployment
 * phase is what proves that.
 *
 * **Additive is the whole point.** The ledger already holds rows written before
 * the column existed; they keep null, and nothing here may rewrite them.
 */

const MIGRATION =
  "prisma/migrations/20261004120000_link_provider_usage_to_usage_period/migration.sql";

const sql = readFileSync(MIGRATION, "utf8");
const schema = readFileSync("prisma/schema.prisma", "utf8");

/** One model's block, from its name to its closing brace. */
function model(name: string): string {
  const match = new RegExp(`^model ${name} \\{[\\s\\S]*?^\\}`, "m").exec(schema);

  expect(match).not.toBeNull();

  return match?.[0] ?? "";
}

describe("the column", () => {
  it("is added to ProviderUsageEvent, nullable and without a default", () => {
    expect(sql).toContain(
      'ALTER TABLE "ProviderUsageEvent" ADD COLUMN     "usagePeriodId" TEXT;',
    );
    expect(sql).not.toMatch(/"usagePeriodId" TEXT NOT NULL/);
    expect(sql).not.toMatch(/"usagePeriodId" TEXT[^;]*DEFAULT/);
  });

  it("is declared in the schema as an optional string", () => {
    expect(model("ProviderUsageEvent")).toMatch(/usagePeriodId\s+String\?/);
  });

  it("is indexed", () => {
    expect(sql).toContain(
      'CREATE INDEX "ProviderUsageEvent_usagePeriodId_idx" ON "ProviderUsageEvent"("usagePeriodId");',
    );
    expect(model("ProviderUsageEvent")).toContain("@@index([usagePeriodId])");
  });
});

/**
 * **`SET NULL`, never a cascade.** What a call cost outlives the period that
 * counted it; deleting a period must not delete the ledger rows about it.
 */
describe("the relation", () => {
  it("references UsagePeriod and sets null when the period goes", () => {
    expect(sql).toContain(
      'ALTER TABLE "ProviderUsageEvent" ADD CONSTRAINT "ProviderUsageEvent_usagePeriodId_fkey" FOREIGN KEY ("usagePeriodId") REFERENCES "UsagePeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;',
    );
    expect(sql).not.toMatch(/"usagePeriodId"[^;]*ON DELETE CASCADE/);
  });

  it("is declared with onDelete: SetNull on both sides", () => {
    expect(model("ProviderUsageEvent")).toMatch(
      /usagePeriod\s+UsagePeriod\?\s+@relation\(fields: \[usagePeriodId\], references: \[id\], onDelete: SetNull\)/,
    );
    expect(model("UsagePeriod")).toMatch(/providerUsageEvents\s+ProviderUsageEvent\[\]/);
  });
});

describe("what the migration leaves alone", () => {
  /** No backfill: the rows written before this column keep null. */
  it("writes no rows", () => {
    expect(sql).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)\b/im);
  });

  it("drops, renames and retypes nothing", () => {
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
    expect(sql).not.toMatch(/ALTER COLUMN/i);
  });

  it("touches no other table", () => {
    const altered = [...sql.matchAll(/ALTER TABLE "(\w+)"/g)].map((match) => match[1]);
    const indexed = [...sql.matchAll(/CREATE INDEX "\w+" ON "(\w+)"/g)].map((match) => match[1]);

    expect(new Set([...altered, ...indexed])).toEqual(new Set(["ProviderUsageEvent"]));
  });
});
