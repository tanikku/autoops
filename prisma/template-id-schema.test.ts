import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * What recording a worker's template promises, in the schema and in its
 * migration.
 *
 * **Read off the files rather than a database**, as the other schema suites
 * are. **Additive is the point**: every existing worker keeps null, and nothing
 * here may write to one of them or constrain what a template is called.
 */

const MIGRATION = "prisma/migrations/20261004170000_add_routine_template_id/migration.sql";

const sql = readFileSync(MIGRATION, "utf8");
const schema = readFileSync("prisma/schema.prisma", "utf8");

function model(name: string): string {
  const match = new RegExp(`^model ${name} \\{[\\s\\S]*?^\\}`, "m").exec(schema);

  expect(match).not.toBeNull();

  return match?.[0] ?? "";
}

describe("the column", () => {
  it("is added to Routine, nullable and without a default", () => {
    expect(sql).toContain('ALTER TABLE "Routine" ADD COLUMN     "templateId" TEXT;');
    expect(sql).not.toMatch(/"templateId" TEXT NOT NULL/);
    expect(sql).not.toMatch(/"templateId" TEXT[^;]*DEFAULT/);
  });

  it("is declared in the schema as an optional string, not an enum or a relation", () => {
    expect(model("Routine")).toMatch(/templateId\s+String\?\s*\n/);
    expect(model("Routine")).not.toMatch(/templateId\s+String\?\s*@/);
  });
});

describe("what the migration leaves alone", () => {
  /** No backfill: existing workers keep null. */
  it("writes no rows", () => {
    expect(sql).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)\b/im);
  });

  it("drops, renames, retypes, indexes and constrains nothing", () => {
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
    expect(sql).not.toMatch(/ALTER COLUMN/i);
    expect(sql).not.toMatch(/CREATE (UNIQUE )?INDEX/i);
    expect(sql).not.toMatch(/FOREIGN KEY|REFERENCES|CONSTRAINT/i);
  });

  it("touches no other table", () => {
    const altered = [...sql.matchAll(/ALTER TABLE "(\w+)"/g)].map((match) => match[1]);

    expect(new Set(altered)).toEqual(new Set(["Routine"]));
  });

  it("is a single statement", () => {
    const statements = sql
      .split(";")
      .map((part) => part.replace(/--.*$/gm, "").trim())
      .filter((part) => part !== "");

    expect(statements).toHaveLength(1);
  });
});
