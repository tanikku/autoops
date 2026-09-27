/**
 * Who may start a checkout while the purchase path is being proved.
 *
 * **A rollout switch, not an entitlement.** What an account is allowed to *have*
 * is `lib/entitlements`, and whether a purchase makes sense for it is
 * `lib/billing/checkout.ts`. This answers a different question — whether the
 * button exists yet at all — and it answers it for one reason: the checkout runs
 * against a sandbox and the people in the Closed Beta are not test subjects. A
 * live-looking purchase button in front of somebody who did not volunteer for it
 * is the failure this prevents, so the two layers stay apart and this one is
 * asked first.
 *
 * **Pure, the same way `lib/beta-access.ts` is pure.** Nothing here reads the
 * environment, a database, or a request; it takes the configured string and an
 * account id and answers yes or no. That is what lets it be tested directly, and
 * it is what keeps the reading of the environment in one server-only place —
 * see `checkout-sandbox-server.ts`.
 *
 * **Temporary by design.** It goes when the checkout is opened to everybody, and
 * the gate that calls it goes with it.
 */

/**
 * Turns the configured list into the account ids it names.
 *
 * **Trimming and dropping blanks, and nothing else.** An account id here is the
 * Google `sub` that every owned row is scoped by — an opaque string the provider
 * chose. Folding its case or normalising its shape would be inventing an
 * equivalence nobody stated, and any invented equivalence in a function whose
 * job is to refuse people is a way in.
 *
 * **An empty entry is not an id.** A trailing comma, a blank line pasted in, a
 * value that is nothing but separators — each would otherwise become `""`, and
 * `""` is a value `isSandboxCheckoutAllowed` could be handed by a caller with no
 * session. Dropping them is also what makes "the list is empty" mean the same
 * thing however it was written.
 *
 * **Repeats collapse.** The same id written twice describes one account, and a
 * list is not a count of anything.
 */
export function parseSandboxCheckoutUserIds(
  value: string | undefined,
): readonly string[] {
  if (!value) {
    return [];
  }

  return [
    ...new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ""),
    ),
  ];
}

/**
 * Whether this account may start a checkout yet.
 *
 * **Closed by default.** An empty list refuses everyone, which is the answer an
 * unset variable has to produce: the point of the list is to keep a sandbox
 * purchase away from real accounts, and a version of it that opened the door
 * when it was missing would fail in exactly the direction it exists to prevent.
 * `CRON_SECRET` refuses every tick when it is unset for the same reason, and so
 * does the beta allowlist.
 *
 * **Exact matches only.** A prefix or a substring test would let a shorter id
 * stand for a longer one, and these ids are consecutive digits — a list holding
 * one account would then admit any account whose id contained it.
 *
 * @param userId the account id from the session, never from a request payload
 * @param allowedIds what `parseSandboxCheckoutUserIds` returned
 */
export function isSandboxCheckoutAllowed(
  userId: string,
  allowedIds: readonly string[],
): boolean {
  if (allowedIds.length === 0) {
    return false;
  }

  // An id nobody is signed in as cannot be on a list: the parse drops empties,
  // so this is belt and braces rather than the only thing stopping it.
  if (userId === "") {
    return false;
  }

  return allowedIds.includes(userId);
}
