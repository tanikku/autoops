import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { admitToPublicBeta } from "@/lib/public-beta-admission";
import { requireTestDatabaseUrl } from "@/integration/test-database";

/**
 * The Public Beta cap against a real PostgreSQL.
 *
 * **What the unit tests cannot show:** that two sign-ins arriving for the last
 * place are serialised by the advisory lock, so the cap holds however they
 * interleave. Each admission uses its own client, so the arrivals really are
 * separate connections racing for the same lock.
 *
 * The table is emptied before each case; this suite runs only against a
 * disposable database (see `test-database.ts`).
 */

const url = requireTestDatabaseUrl();
const clients: PrismaClient[] = [];

function client(): PrismaClient {
  const created = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  clients.push(created);
  return created;
}

const admin = client();
const RUN = `${process.pid}-${Date.now().toString(36)}`;
const sub = (n: number) => `public-beta-${RUN}-${n}`;

beforeEach(async () => {
  await admin.publicBetaAdmission.deleteMany({});
});

afterAll(async () => {
  await admin.publicBetaAdmission.deleteMany({});
  await Promise.all(clients.map((each) => each.$disconnect()));
});

describe("admitting to the Public Beta", () => {
  it("admits exactly ten, one at a time, and refuses the eleventh", async () => {
    for (let n = 1; n <= 10; n += 1) {
      expect(await admitToPublicBeta(admin, sub(n), 10)).toBe("admitted");
    }

    expect(await admitToPublicBeta(admin, sub(11), 10)).toBe("full");
    expect(await admin.publicBetaAdmission.count()).toBe(10);
  });

  it("gives the tenth place to exactly one of two simultaneous arrivals", async () => {
    await admin.publicBetaAdmission.createMany({
      data: Array.from({ length: 9 }, (_, i) => ({ userId: sub(i + 1) })),
    });

    const outcomes = await Promise.all([
      admitToPublicBeta(client(), sub(10), 10),
      admitToPublicBeta(client(), sub(11), 10),
    ]);

    expect([...outcomes].sort()).toEqual(["admitted", "full"]);
    expect(await admin.publicBetaAdmission.count()).toBe(10);
  });

  it("never passes the cap with twenty arriving at once", async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, i) => admitToPublicBeta(client(), sub(i + 1), 10)),
    );

    expect(outcomes.filter((outcome) => outcome === "admitted")).toHaveLength(10);
    expect(await admin.publicBetaAdmission.count()).toBe(10);
  });

  it("does not take a second place for somebody already admitted", async () => {
    expect(await admitToPublicBeta(admin, sub(1), 10)).toBe("admitted");

    const again = await Promise.all([
      admitToPublicBeta(client(), sub(1), 10),
      admitToPublicBeta(client(), sub(1), 10),
    ]);

    expect(again).toEqual(["admitted", "admitted"]);
    expect(await admin.publicBetaAdmission.count()).toBe(1);
  });

  it("lets an admitted participant back in even when the beta is full", async () => {
    await admin.publicBetaAdmission.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({ userId: sub(i + 1) })),
    });

    expect(await admitToPublicBeta(admin, sub(3), 10)).toBe("admitted");
    expect(await admitToPublicBeta(admin, sub(99), 10)).toBe("full");
  });

  it("takes nobody when the cap is zero", async () => {
    expect(await admitToPublicBeta(admin, sub(1), 0)).toBe("full");
    expect(await admin.publicBetaAdmission.count()).toBe(0);
  });
});
