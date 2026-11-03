import { describe, expect, it, vi } from "vitest";
import {
  AccountDeletedError,
  checkTombstone,
  lockSubject,
  readTombstoneKeyring,
  SUBJECT_LOCK_NAMESPACE,
  subjectLockKey,
  TOMBSTONE_KEYS_ENV,
  TombstoneUnverifiableError,
  tombstoneHash,
  tombstoneRecord,
} from "@/lib/account-tombstone";

/**
 * The tombstone of a deleted account: a keyed hash of the Google subject, the
 * version of the key that made it, and the rules for reading the keys.
 *
 * The keys below are fixed dummies, never anything deployed.
 */

const SECRET_1 = Buffer.alloc(32, 1);
const SECRET_2 = Buffer.alloc(32, 2);
const KEY_1 = `1:${SECRET_1.toString("base64")}`;
const KEY_2 = `2:${SECRET_2.toString("base64")}`;
const env = (value: string | undefined) => ({ [TOMBSTONE_KEYS_ENV]: value });

describe("the hash", () => {
  it("is the same for the same subject and key", () => {
    expect(tombstoneHash(SECRET_1, "sub-a")).toBe(tombstoneHash(SECRET_1, "sub-a"));
  });

  it("differs between subjects", () => {
    expect(tombstoneHash(SECRET_1, "sub-a")).not.toBe(tombstoneHash(SECRET_1, "sub-b"));
  });

  it("differs between keys", () => {
    expect(tombstoneHash(SECRET_1, "sub-a")).not.toBe(tombstoneHash(SECRET_2, "sub-a"));
  });

  it("is HMAC-SHA256 over the prefixed subject, as hex, and contains no subject", () => {
    const hash = tombstoneHash(SECRET_1, "sub-a");

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("sub-a");
  });
});

describe("reading the keys", () => {
  it("reads several versions and writes with the newest", () => {
    const read = readTombstoneKeyring(env(`${KEY_1},${KEY_2}`));

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.keyring.current.version).toBe(2);
    expect(read.keyring.keys.map((key) => key.version)).toEqual([2, 1]);
  });

  it("accepts URL-safe base64 and surrounding space", () => {
    const urlSafe = Buffer.alloc(32, 0xfb).toString("base64url");

    expect(readTombstoneKeyring(env(` 7:${urlSafe} `)).ok).toBe(true);
  });

  it.each([
    ["absent", undefined, "missing"],
    ["empty", "", "missing"],
    ["blank", "   ", "missing"],
    ["without a version", SECRET_1.toString("base64"), "malformed-entry"],
    ["with an empty secret", "1:", "malformed-entry"],
    ["with a version of zero", `0:${SECRET_1.toString("base64")}`, "bad-version"],
    ["with a word for a version", `v1:${SECRET_1.toString("base64")}`, "bad-version"],
    ["with a repeated version", `${KEY_1},1:${SECRET_2.toString("base64")}`, "duplicate-version"],
    ["with a short secret", `1:${Buffer.alloc(31, 1).toString("base64")}`, "short-secret"],
    ["with a trailing comma", `${KEY_1},`, "malformed-entry"],
    ["with one good and one bad entry", `${KEY_1},2:not base64!`, "malformed-entry"],
  ])("refuses keys %s", (_label, value, problem) => {
    expect(readTombstoneKeyring(env(value))).toEqual({ ok: false, problem });
  });

  it("never puts a secret in what it returns about a bad set", () => {
    const secretText = Buffer.alloc(16, 9).toString("base64");
    const read = readTombstoneKeyring(env(`1:${secretText}`));

    expect(JSON.stringify(read)).not.toContain(secretText);
  });

  it("writes a new tombstone with the newest key", () => {
    const read = readTombstoneKeyring(env(`${KEY_1},${KEY_2}`));
    if (!read.ok) throw new Error("keys did not parse");

    expect(tombstoneRecord(read.keyring, "sub-a")).toEqual({
      subjectHash: tombstoneHash(SECRET_2, "sub-a"),
      keyVersion: 2,
    });
  });
});

describe("checking a subject", () => {
  /** A stand-in for the table: rows by version and hash. */
  function table(rows: { keyVersion: number; subjectHash: string }[]) {
    const findFirst = vi.fn(
      async ({ where }: { where: Record<string, unknown> }) => {
        if ("OR" in where) {
          const wanted = where.OR as { keyVersion: number; subjectHash: string }[];
          return rows.some((row) =>
            wanted.some((w) => w.keyVersion === row.keyVersion && w.subjectHash === row.subjectHash),
          )
            ? { id: "tombstone" }
            : null;
        }
        const known = (where.keyVersion as { notIn: number[] }).notIn;
        return rows.some((row) => !known.includes(row.keyVersion)) ? { id: "tombstone" } : null;
      },
    );
    return { client: { deletedAccount: { findFirst } } as never, findFirst };
  }

  it("finds a subject deleted under the current key", async () => {
    const { client } = table([{ keyVersion: 2, subjectHash: tombstoneHash(SECRET_2, "sub-a") }]);

    expect(await checkTombstone(client, "sub-a", env(`${KEY_1},${KEY_2}`))).toBe("deleted");
  });

  it("finds a subject deleted under an older key that is still configured", async () => {
    const { client } = table([{ keyVersion: 1, subjectHash: tombstoneHash(SECRET_1, "sub-a") }]);

    expect(await checkTombstone(client, "sub-a", env(`${KEY_1},${KEY_2}`))).toBe("deleted");
  });

  it("calls a subject with no tombstone clear", async () => {
    const { client } = table([{ keyVersion: 1, subjectHash: tombstoneHash(SECRET_1, "sub-b") }]);

    expect(await checkTombstone(client, "sub-a", env(KEY_1))).toBe("clear");
  });

  it("does not match a hash made under a different version", async () => {
    const { client } = table([{ keyVersion: 1, subjectHash: tombstoneHash(SECRET_2, "sub-a") }]);

    expect(await checkTombstone(client, "sub-a", env(`${KEY_1},${KEY_2}`))).toBe("clear");
  });

  it("cannot call anybody clear while a row's key is not configured", async () => {
    const { client } = table([{ keyVersion: 1, subjectHash: tombstoneHash(SECRET_1, "sub-b") }]);

    expect(await checkTombstone(client, "sub-a", env(KEY_2))).toBe("unverifiable");
  });

  it.each([undefined, "", "1:short"])("asks nothing and answers unverifiable for keys %o", async (value) => {
    const { client, findFirst } = table([]);

    expect(await checkTombstone(client, "sub-a", env(value))).toBe("unverifiable");
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("asks the table for hashes, never for the subject", async () => {
    const { client, findFirst } = table([]);

    await checkTombstone(client, "sub-a", env(KEY_1));

    expect(JSON.stringify(findFirst.mock.calls)).not.toContain("sub-a");
  });
});

describe("the subject's lock", () => {
  it("is the same key for the same subject, and a different one otherwise", () => {
    expect(subjectLockKey("sub-a")).toBe(subjectLockKey("sub-a"));
    expect(subjectLockKey("sub-a")).not.toBe(subjectLockKey("sub-b"));
  });

  it("fits PostgreSQL's 32-bit key", () => {
    for (const subject of ["sub-a", "sub-b", "1234567890123456789012", ""]) {
      const key = subjectLockKey(subject);
      expect(Number.isInteger(key)).toBe(true);
      expect(key).toBeGreaterThanOrEqual(-(2 ** 31));
      expect(key).toBeLessThan(2 ** 31);
    }
  });

  it("is taken with the two-key form, under its own namespace, with no subject in it", async () => {
    const executeRaw = vi.fn(async () => 0);

    await lockSubject({ $executeRaw: executeRaw } as never, "sub-a");

    const [strings, ...values] = executeRaw.mock.calls[0] as unknown as [string[], ...unknown[]];
    expect(strings.join("?")).toContain("pg_advisory_xact_lock(");
    expect(strings.join("?")).toContain("::int4");
    expect(values).toEqual([SUBJECT_LOCK_NAMESPACE, subjectLockKey("sub-a")]);
    expect(JSON.stringify(executeRaw.mock.calls)).not.toContain("sub-a");
  });
});

describe("the refusals", () => {
  it("say nothing about which subject", () => {
    expect(new AccountDeletedError().message).not.toMatch(/sub/);
    expect(new TombstoneUnverifiableError().message).not.toMatch(/sub/);
  });
});
