import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import {
  AccountDeletedError,
  checkTombstone,
  lockSubject,
  readTombstoneKeyring,
  TOMBSTONE_KEYS_ENV,
  TombstoneUnverifiableError,
  tombstoneRecord,
} from "@/lib/account-tombstone";
import { PUBLIC_BETA_ADMISSION_LOCK, admitToPublicBeta } from "@/lib/public-beta-admission";
import { ensureUser } from "@/lib/users";
import { requireTestDatabaseUrl } from "@/integration/test-database";

/**
 * Tombstones against a real PostgreSQL: that a deleted subject cannot get an
 * account row or a Public Beta place back, however the writes interleave.
 *
 * **There is no account deletion yet.** Where a case needs one, it is played by
 * a transaction written here that takes the locks a deletion will take, in the
 * order the design fixes — the subject's lock, the account's row, then the
 * admission lock — and writes what a deletion will write.
 *
 * Every connection carries a `lock_timeout`, so a wait that would never end
 * fails the case instead of hanging it; PostgreSQL's own deadlock detector
 * would fail it too. The keys are fixed dummies.
 */

const url = requireTestDatabaseUrl();

/**
 * A fixed set of clients, handed out in turn. Each is its own pool, so two
 * calls given different clients really are different connections; a fresh
 * client per call would open a pool per call and run the server out of them.
 */
const clients: PrismaClient[] = Array.from(
  { length: 8 },
  () =>
    new PrismaClient({
      adapter: new PrismaPg({ connectionString: url, options: "-c lock_timeout=5000", max: 4 }),
    }),
);
let next = 0;

function client(): PrismaClient {
  next = (next + 1) % clients.length;
  return clients[next];
}

const admin = clients[0];
const RUN = `${process.pid}-${Date.now().toString(36)}`;
const sub = (n: number) => `tombstone-${RUN}-${n}`;
const person = (n: number, email = `t-${RUN}-${n}@example.test`) => ({ id: sub(n), email });

const KEY_1 = `1:${Buffer.alloc(32, 11).toString("base64")}`;
const KEY_2 = `2:${Buffer.alloc(32, 22).toString("base64")}`;

function keyring(value: string) {
  const read = readTombstoneKeyring({ [TOMBSTONE_KEYS_ENV]: value });
  if (!read.ok) throw new Error(`test keys did not parse: ${read.problem}`);
  return read.keyring;
}

async function writeTombstone(n: number, keys = KEY_1, db: PrismaClient = admin) {
  await db.deletedAccount.create({ data: tombstoneRecord(keyring(keys), sub(n)) });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What an account deletion will do, under the locks it will take, in their
 * order. `pause` runs while every lock is held and nothing is committed yet.
 */
async function playDeletion(
  db: PrismaClient,
  n: number,
  options: { pause?: () => Promise<void>; failAfterWrites?: boolean } = {},
) {
  await db.$transaction(
    async (tx) => {
      await lockSubject(tx, sub(n));
      await tx.user.updateMany({ where: { id: sub(n) }, data: { id: sub(n) } });
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PUBLIC_BETA_ADMISSION_LOCK}::bigint)`;
      await tx.deletedAccount.create({ data: tombstoneRecord(keyring(KEY_1), sub(n)) });
      await tx.publicBetaAdmission.deleteMany({ where: { userId: sub(n) } });
      await tx.user.deleteMany({ where: { id: sub(n) } });
      await options.pause?.();
      if (options.failAfterWrites) {
        throw new Error("deletion failed on purpose");
      }
    },
    { timeout: 20_000 },
  );
}

async function userExists(n: number) {
  return (await admin.user.findUnique({ where: { id: sub(n) }, select: { id: true } })) !== null;
}

async function tombstoneExists(n: number) {
  return (await checkTombstone(admin, sub(n), { [TOMBSTONE_KEYS_ENV]: KEY_1 })) === "deleted";
}

async function cleanup() {
  await admin.publicBetaAdmission.deleteMany({});
  await admin.deletedAccount.deleteMany({});
  await admin.user.deleteMany({ where: { id: { startsWith: `tombstone-${RUN}-` } } });
}

beforeEach(async () => {
  vi.stubEnv(TOMBSTONE_KEYS_ENV, KEY_1);
  await cleanup();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await cleanup();
  await Promise.all(clients.map((each) => each.$disconnect()));
});

describe("writing an account row", () => {
  it("A: refuses a deleted subject and writes no row", async () => {
    await writeTombstone(1);

    await expect(ensureUser(person(1), admin)).rejects.toBeInstanceOf(AccountDeletedError);
    expect(await userExists(1)).toBe(false);
  });

  it("B: creates the row for a subject with no tombstone, and refreshes it after", async () => {
    await ensureUser(person(1), admin);
    await ensureUser(person(1, `renamed-${RUN}@example.test`), admin);

    const row = await admin.user.findUnique({ where: { id: sub(1) } });
    expect(row?.email).toBe(`renamed-${RUN}@example.test`);
    // The zone is the column default, untouched by provisioning.
    expect(row?.timezone).toBe("Asia/Tokyo");
  });

  it("C: makes exactly one row from five simultaneous first writes", async () => {
    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, () => ensureUser(person(1), client())),
    );

    expect(outcomes.every((o) => o.status === "fulfilled")).toBe(true);
    expect(await admin.user.count({ where: { id: sub(1) } })).toBe(1);
  });

  it("D: does not bring the row back when a deletion holds the subject's lock", async () => {
    await ensureUser(person(1), admin);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deletion = playDeletion(client(), 1, { pause: () => held });

    await sleep(200);
    // Waits on the deletion's lock, then reads what it committed.
    const write = ensureUser(person(1), client()).then(
      () => "written",
      (error: unknown) => error,
    );
    await sleep(200);
    release();
    await deletion;

    expect(await write).toBeInstanceOf(AccountDeletedError);
    expect(await userExists(1)).toBe(false);
    expect(await tombstoneExists(1)).toBe(true);
  });

  it("D: never leaves a row beside a tombstone, however a write and a deletion race", async () => {
    for (let round = 0; round < 10; round += 1) {
      await cleanup();
      await ensureUser(person(round), admin);

      await Promise.allSettled([
        playDeletion(client(), round),
        ensureUser(person(round), client()),
        ensureUser(person(round), client()),
      ]);

      expect(await tombstoneExists(round)).toBe(true);
      expect(await userExists(round)).toBe(false);
    }
  });
});

describe("taking a Public Beta place", () => {
  it("E: refuses a deleted subject, even one that still has a place", async () => {
    await admin.publicBetaAdmission.create({ data: { userId: sub(1) } });
    await writeTombstone(1);

    expect(await admitToPublicBeta(admin, sub(1), 10)).toEqual({ status: "refused" });
  });

  it("E: does not write a place back after a deletion removed it", async () => {
    await admin.publicBetaAdmission.create({ data: { userId: sub(1) } });

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deletion = playDeletion(client(), 1, { pause: () => held });

    await sleep(200);
    const admission = admitToPublicBeta(client(), sub(1), 10);
    await sleep(200);
    release();
    await deletion;

    expect(await admission).toEqual({ status: "refused" });
    expect(await admin.publicBetaAdmission.count({ where: { userId: sub(1) } })).toBe(0);
  });

  it("E: never leaves a place beside a tombstone, however they race", async () => {
    for (let round = 0; round < 10; round += 1) {
      await cleanup();

      await Promise.allSettled([
        admitToPublicBeta(client(), sub(round), 10),
        playDeletion(client(), round),
        admitToPublicBeta(client(), sub(round), 10),
      ]);

      expect(await tombstoneExists(round)).toBe(true);
      expect(await admin.publicBetaAdmission.count({ where: { userId: sub(round) } })).toBe(0);
    }
  });

  it("F: still never passes the cap with twenty arriving at once", async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, i) => admitToPublicBeta(client(), sub(i + 1), 10)),
    );

    expect(outcomes.filter((o) => o.status === "joined")).toHaveLength(10);
    expect(await admin.publicBetaAdmission.count()).toBe(10);
  });

  it("F: keeps the cap while a deletion frees a place in the middle of the rush", async () => {
    await admin.publicBetaAdmission.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({ userId: sub(i + 1) })),
    });

    await Promise.allSettled([
      playDeletion(client(), 1),
      ...Array.from({ length: 10 }, (_, i) => admitToPublicBeta(client(), sub(100 + i), 10)),
    ]);

    expect(await admin.publicBetaAdmission.count()).toBeLessThanOrEqual(10);
    expect(await admin.publicBetaAdmission.count({ where: { userId: sub(1) } })).toBe(0);
  });
});

describe("locks", () => {
  it("G/L: takes the subject's lock before the admission lock, with no deadlock under mixed load", async () => {
    await ensureUser(person(1), admin);

    const outcomes = await Promise.allSettled([
      playDeletion(client(), 1),
      ensureUser(person(1), client()),
      admitToPublicBeta(client(), sub(1), 10),
      ensureUser(person(2), client()),
      admitToPublicBeta(client(), sub(3), 10),
      playDeletion(client(), 4),
      admitToPublicBeta(client(), sub(4), 10),
    ]);

    const failures = outcomes.flatMap((o) => (o.status === "rejected" ? [o.reason] : []));
    // Refusals of the deleted subjects are expected; a lock failure is not.
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(AccountDeletedError);
    }
    expect(JSON.stringify(failures)).not.toMatch(/deadlock|lock timeout|40P01|55P03/i);
    expect(await userExists(1)).toBe(false);
    expect(await userExists(2)).toBe(true);
  });

  it("H: handles different subjects independently", async () => {
    await writeTombstone(3);

    const outcomes = await Promise.allSettled(
      [1, 2, 3, 4, 5].map((n) => ensureUser(person(n), client())),
    );

    expect(outcomes.map((o) => o.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "rejected",
      "fulfilled",
      "fulfilled",
    ]);
    expect(await admin.user.count({ where: { id: { startsWith: `tombstone-${RUN}-` } } })).toBe(4);
  });

  it("I: leaves nothing behind when a deletion fails part-way", async () => {
    await ensureUser(person(1), admin);
    await admin.publicBetaAdmission.create({ data: { userId: sub(1) } });

    await expect(playDeletion(client(), 1, { failAfterWrites: true })).rejects.toThrow(
      "deletion failed on purpose",
    );

    expect(await tombstoneExists(1)).toBe(false);
    expect(await userExists(1)).toBe(true);
    expect(await admin.publicBetaAdmission.count({ where: { userId: sub(1) } })).toBe(1);
  });
});

describe("keys", () => {
  it("J: refuses a subject deleted under an older key that is still configured", async () => {
    await writeTombstone(1, KEY_1);
    vi.stubEnv(TOMBSTONE_KEYS_ENV, `${KEY_1},${KEY_2}`);

    await expect(ensureUser(person(1), admin)).rejects.toBeInstanceOf(AccountDeletedError);
    expect(await admitToPublicBeta(admin, sub(1), 10)).toEqual({ status: "refused" });
  });

  it("J: refuses newcomers while a written version's key is missing", async () => {
    await writeTombstone(1, KEY_1);
    vi.stubEnv(TOMBSTONE_KEYS_ENV, KEY_2);

    await expect(ensureUser(person(2), admin)).rejects.toBeInstanceOf(TombstoneUnverifiableError);
    expect(await admitToPublicBeta(admin, sub(2), 10)).toEqual({ status: "refused" });
  });

  it("K: refuses a new subject without keys, and still refreshes an existing row", async () => {
    await ensureUser(person(1), admin);
    vi.stubEnv(TOMBSTONE_KEYS_ENV, "");

    await expect(ensureUser(person(2), admin)).rejects.toBeInstanceOf(TombstoneUnverifiableError);
    expect(await userExists(2)).toBe(false);
    await expect(ensureUser(person(1, `kept-${RUN}@example.test`), admin)).resolves.toBeUndefined();
    expect(await admitToPublicBeta(admin, sub(3), 10)).toEqual({ status: "refused" });
    expect(await admin.publicBetaAdmission.count()).toBe(0);
  });
});
