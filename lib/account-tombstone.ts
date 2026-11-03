import "server-only";

import { createHash, createHmac } from "node:crypto";
import type { DbClient } from "@/lib/prisma";

/**
 * What remains of a deleted account: enough to refuse it, and nothing else.
 *
 * **A keyed hash of the Google subject, never the subject.** The subject is the
 * id every owned row was scoped by and the one value that identifies a person
 * across sign-ins; a deleted account must not keep it. What is stored instead is
 * `HMAC-SHA256(key, "google:" + subject)` and the version of the key that made
 * it — so the table can answer "has this subject been deleted" for somebody who
 * presents the subject, and cannot be read back into a list of people.
 *
 * **Keys are added, never replaced.** A tombstone can only be checked with the
 * key that wrote it, and the subject it was made from is gone, so it can never
 * be rewritten under a new key. Every version that ever wrote a row has to stay
 * configured for as long as the row exists.
 *
 * **Unknown is not clear.** A check that cannot be completed — no keys, keys
 * that do not parse, or a row written by a version that is not configured —
 * answers `unverifiable`, and callers treat that as a refusal for anybody who
 * does not already have an account. Treating it as "not deleted" would let a
 * configuration mistake undo a deletion.
 */

/** The environment variable the keys are read from. Its own, shared with nothing. */
export const TOMBSTONE_KEYS_ENV = "ACCOUNT_TOMBSTONE_KEYS";

/** The shortest secret accepted, in bytes. HMAC-SHA256's own block of entropy. */
const MIN_SECRET_BYTES = 32;

export type TombstoneKey = { readonly version: number; readonly secret: Buffer };

export type TombstoneKeyring = {
  /** The newest version, which a new tombstone is written with. */
  readonly current: TombstoneKey;
  /** Every configured version, newest first. Each can check what it wrote. */
  readonly keys: readonly TombstoneKey[];
};

/**
 * Why the keys could not be used. A category only — never a key, and never the
 * text that failed to parse, since that text is the secret.
 */
export type TombstoneKeyringProblem =
  | "missing"
  | "malformed-entry"
  | "bad-version"
  | "duplicate-version"
  | "short-secret";

export type TombstoneKeyringRead =
  | { readonly ok: true; readonly keyring: TombstoneKeyring }
  | { readonly ok: false; readonly problem: TombstoneKeyringProblem };

const VERSION = /^[1-9]\d{0,5}$/;
// Standard or URL-safe base64; Node decodes both under "base64".
const SECRET = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * Reads `ACCOUNT_TOMBSTONE_KEYS`: `version:secret` pairs separated by commas,
 * each secret base64 of at least 32 bytes — `1:…,2:…`.
 *
 * **One bad entry spoils the whole set.** Using the entries that did parse
 * would quietly drop a version, and every tombstone that version wrote would
 * read as "not deleted" — the failure this module exists to prevent.
 */
export function readTombstoneKeyring(
  env: Readonly<Record<string, string | undefined>> = process.env,
): TombstoneKeyringRead {
  const raw = env[TOMBSTONE_KEYS_ENV]?.trim() ?? "";

  if (raw === "") {
    return { ok: false, problem: "missing" };
  }

  const keys: TombstoneKey[] = [];
  const seen = new Set<number>();

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    const separator = trimmed.indexOf(":");

    if (separator <= 0) {
      return { ok: false, problem: "malformed-entry" };
    }

    const versionText = trimmed.slice(0, separator).trim();
    const secretText = trimmed.slice(separator + 1).trim();

    if (!VERSION.test(versionText)) {
      return { ok: false, problem: "bad-version" };
    }

    if (!SECRET.test(secretText)) {
      return { ok: false, problem: "malformed-entry" };
    }

    const version = Number(versionText);
    if (seen.has(version)) {
      return { ok: false, problem: "duplicate-version" };
    }

    const secret = Buffer.from(secretText, "base64");
    if (secret.length < MIN_SECRET_BYTES) {
      return { ok: false, problem: "short-secret" };
    }

    seen.add(version);
    keys.push({ version, secret });
  }

  keys.sort((a, b) => b.version - a.version);
  return { ok: true, keyring: { current: keys[0], keys } };
}

/** `HMAC-SHA256(secret, "google:" + subject)`, hex. */
export function tombstoneHash(secret: Buffer, subject: string): string {
  return createHmac("sha256", secret).update(`google:${subject}`).digest("hex");
}

/**
 * The row a deletion would write for this subject, under the current key.
 *
 * Nothing in this change writes one: account deletion is a later phase. It is
 * here so that the shape of a tombstone is defined once, next to the check that
 * reads it.
 */
export function tombstoneRecord(
  keyring: TombstoneKeyring,
  subject: string,
): { readonly subjectHash: string; readonly keyVersion: number } {
  return {
    subjectHash: tombstoneHash(keyring.current.secret, subject),
    keyVersion: keyring.current.version,
  };
}

/** Whether a subject has been deleted, as far as can be known. */
export type TombstoneStatus = "deleted" | "clear" | "unverifiable";

/**
 * The subject has been deleted, so no account may be written for it.
 *
 * **Says nothing about which subject.** The message is read in logs; the
 * subject is exactly what a deleted account must not leave behind.
 */
export class AccountDeletedError extends Error {
  constructor() {
    super("This account has been deleted and cannot be used again.");
    this.name = "AccountDeletedError";
  }
}

export function isAccountDeletedError(error: unknown): boolean {
  return error instanceof AccountDeletedError;
}

/**
 * Whether the subject was deleted could not be established, so no new account
 * may be written for it. Carries the category of the problem and nothing else.
 */
export class TombstoneUnverifiableError extends Error {
  constructor() {
    super("Whether this account was deleted could not be checked.");
    this.name = "TombstoneUnverifiableError";
  }
}

/**
 * Checks a subject against every configured key, inside whatever transaction
 * it is given.
 *
 * **Asked after the subject's lock, by every writer.** A check made before the
 * lock would describe a moment another transaction may already have changed;
 * made after it, under PostgreSQL's default isolation, it reads whatever the
 * last holder committed.
 */
export async function checkTombstone(
  client: DbClient,
  subject: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<TombstoneStatus> {
  const read = readTombstoneKeyring(env);

  if (!read.ok) {
    return "unverifiable";
  }

  const { keys } = read.keyring;

  const match = await client.deletedAccount.findFirst({
    where: {
      OR: keys.map((key) => ({
        keyVersion: key.version,
        subjectHash: tombstoneHash(key.secret, subject),
      })),
    },
    select: { id: true },
  });

  if (match !== null) {
    return "deleted";
  }

  // **A row this deployment cannot read is a row that might be this subject.**
  // A version missing from the keys means its tombstones cannot be checked, so
  // "no match" would be a guess.
  const unreadable = await client.deletedAccount.findFirst({
    where: { keyVersion: { notIn: keys.map((key) => key.version) } },
    select: { id: true },
  });

  return unreadable === null ? "clear" : "unverifiable";
}

/**
 * The advisory-lock namespace for subjects. Fixed and arbitrary.
 *
 * **The two-key form, on purpose.** PostgreSQL keeps advisory locks taken with
 * two 32-bit keys apart from those taken with one 64-bit key, so nothing here
 * can collide with `PUBLIC_BETA_ADMISSION_LOCK`, which uses the other form.
 */
export const SUBJECT_LOCK_NAMESPACE = 1_263_617_108;

/**
 * The lock key for a subject: deterministic, and not the subject itself.
 *
 * **A collision is harmless.** Two subjects sharing a key only wait for each
 * other; neither can act for the other. That is the direction a hash this short
 * is allowed to fail in.
 */
export function subjectLockKey(subject: string): number {
  return createHash("sha256")
    .update(`koqentra:subject-lock:${subject}`)
    .digest()
    .readInt32BE(0);
}

/**
 * Takes this subject's lock for the rest of the transaction.
 *
 * **Always first.** Whatever else a transaction locks — the account's row, the
 * Public Beta admission lock — it takes this before it, so no two transactions
 * can each hold what the other is waiting for.
 */
export async function lockSubject(client: DbClient, subject: string): Promise<void> {
  await client.$executeRaw`SELECT pg_advisory_xact_lock(${SUBJECT_LOCK_NAMESPACE}::int4, ${subjectLockKey(subject)}::int4)`;
}
