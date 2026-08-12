/**
 * Who is allowed to sign in while AutoOps is in Closed Beta.
 *
 * **Pure on purpose.** Nothing here reads the environment, a database, or a
 * request — it takes the configured string and the profile a provider returned
 * and answers yes or no. That is what lets it be tested directly, and it is
 * what keeps `auth.ts` free of anything the edge cannot run: the middleware
 * imports that file, and the reason there is no database adapter at all is to
 * keep it that way.
 *
 * **Temporary by design.** This exists because the beta is invite-only. When it
 * stops being invite-only, the file goes and `auth.ts` loses one callback.
 */

/**
 * Turns the configured list into the addresses it names.
 *
 * **Trimming and lower-casing, and nothing else.** Providers differ in what
 * they consider the same address — Gmail ignores dots, several treat `+tag` as
 * an alias — and reproducing any of that here would be guessing on the
 * provider's behalf. Guessing wide lets in an address nobody listed; guessing
 * narrow locks out someone who was. What is written in the variable is what is
 * compared, once both sides have had their surrounding space removed and their
 * case settled.
 *
 * **An empty entry is not an address.** A trailing comma, a blank line pasted
 * in, a list that is nothing but separators — each of those would otherwise
 * become `""`, and `""` matching anything would be the worst possible bug in a
 * function whose job is to refuse people. They are dropped, which is also what
 * makes "the list is empty" mean the same thing however it was written.
 */
export function parseBetaAllowlist(value: string | undefined): Set<string> {
  if (!value) {
    return new Set();
  }

  return new Set(
    value
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry !== ""),
  );
}

/**
 * Whether this profile may sign in.
 *
 * **Closed by default.** An empty list refuses everyone, which is the answer a
 * forgotten environment variable has to produce: the point of the list is to
 * keep uninvited people out of production, and a version of it that opens the
 * door when it is missing would fail in exactly the direction it exists to
 * prevent. `CRON_SECRET` refuses every tick when it is unset for the same
 * reason.
 *
 * **An unverified address is not an address.** A provider that has not
 * confirmed the mailbox has not established that the person signing in owns
 * it, and the list is written in terms of mailboxes. `email_verified` is
 * missing rather than false on providers that do not report it, so this asks
 * for `true` rather than for "not false".
 *
 * @param profile what the provider returned, or nothing if it returned nothing
 * @param allowlist the addresses from `parseBetaAllowlist`
 */
export function isBetaSignInAllowed(
  profile:
    | { email?: string | null; email_verified?: boolean | null }
    | undefined,
  allowlist: Set<string>,
): boolean {
  if (allowlist.size === 0) {
    return false;
  }

  if (!profile || profile.email_verified !== true) {
    return false;
  }

  // Both sides are settled the same way, so a list written in capitals and an
  // address returned in lower case still describe the same mailbox. An empty
  // one cannot match: `parseBetaAllowlist` never puts `""` in the set.
  const email = profile.email?.trim().toLowerCase();

  return email !== undefined && allowlist.has(email);
}
