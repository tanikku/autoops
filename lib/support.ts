import "server-only";

/**
 * Where somebody writes to when Koqentra is not doing what they expected.
 *
 * **One definition, read from the environment.** The address is not a secret —
 * it is meant to be read off a screen — but it is also not a fact about the
 * code, and inventing one would be worse than having none: a `mailto:` that
 * goes nowhere is a dead end dressed up as a way out. Keeping it in the
 * environment means the value can be set without a source change, and means
 * this file never has to hold a guess.
 *
 * **A deployment with nothing set shows no support link at all.** That is the
 * same shape as the notification provider: a missing variable makes the feature
 * absent rather than broken, and nothing tells the reader that somebody forgot
 * to configure something — which is an operator's problem, not theirs.
 */

/**
 * The address, or null when there is none worth showing.
 *
 * **What is refused is anything that could not work as a `mailto:`.** A value
 * with whitespace or control characters in it would produce a link that either
 * fails silently or carries something nobody typed, and a value with no `@` is
 * not an address at all. This is a sanity check on a value an operator set, not
 * a validator: an address that satisfies it may still bounce.
 */
export function supportEmailAddress(): string | null {
  const value = process.env.SUPPORT_EMAIL?.trim();

  if (!value) {
    return null;
  }

  const usable =
    value.includes("@") && !/[\s\p{Cc}\p{Cf}]/u.test(value) && value.length <= 254;

  return usable ? value : null;
}

/**
 * A `mailto:` for the support address, with the subject already filled in.
 *
 * **The subject is encoded rather than pasted.** It comes from the dictionary
 * and so may hold spaces, Japanese, or an ampersand, and all three would end
 * the query string early or be dropped if they travelled raw.
 *
 * **The address itself is not encoded**, deliberately: it is the path part of
 * the URL rather than a query value, `supportEmailAddress` has already refused
 * anything with a character that needs escaping there, and encoding it would
 * turn a working `mailto:` into a broken one in the clients that take it
 * literally.
 *
 * Null whenever the address is, so a caller cannot render a link to nowhere.
 */
export function supportMailtoHref(subject: string): string | null {
  const address = supportEmailAddress();

  if (address === null) {
    return null;
  }

  const trimmed = subject.trim();

  return trimmed === ""
    ? `mailto:${address}`
    : `mailto:${address}?subject=${encodeURIComponent(trimmed)}`;
}
