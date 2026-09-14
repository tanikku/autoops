/**
 * What a discovery worker deals in, said without naming a provider.
 *
 * **The point of this file is the line it draws.** A discovery worker asks
 * somewhere outside Koqentra what exists, narrows the answer, and picks a few
 * things out of it. Which service was asked is an implementation detail of the
 * asking, and nothing downstream of the adapter should be able to tell — so no
 * type here has a field that only YouTube would have, and no raw provider
 * response reaches this far.
 *
 * **Nothing uses these yet.** `routineKinds` does not contain `discovery`, so
 * no worker can be saved as one; this is the shape being settled before
 * anything depends on it. See `prisma/schema.prisma` for the same decision
 * about the tables.
 */

/**
 * Where candidates come from.
 *
 * **A closed set narrowed from a plain String column**, the same shape as
 * `RoutineKind`, `RoutineStatus` and `RoutineFrequency` — so adding a provider
 * is a line here rather than a migration. The database column is a plain
 * `String`, and this guard is the only thing standing between a stored value
 * and code that assumes it can be handled.
 *
 * One entry, deliberately. A second provider is a decision to make with a
 * second provider in hand, not a slot to leave open.
 */
export const discoverySourceKinds = ["youtube"] as const;

export type DiscoverySourceKind = (typeof discoverySourceKinds)[number];

export function isDiscoverySourceKind(
  value: string,
): value is DiscoverySourceKind {
  return (discoverySourceKinds as readonly string[]).includes(value);
}

/**
 * One question to ask a provider.
 *
 * **`maxCandidates` is a ceiling on the answer, not on what is chosen.** How
 * many things a run may pick is the owner's setting; how many it looks at
 * before picking is a constant nobody sets — see `lib/discovery/limits.ts`.
 * Keeping them apart is what stops "show me five" from meaning "only ever
 * consider five".
 */
export type DiscoveryQuery = {
  source: DiscoverySourceKind;
  query: string;
  maxCandidates: number;
};

/**
 * One thing found, after the adapter has made sense of it.
 *
 * **Five fields, and the restraint is the design.** A candidate carries what
 * is needed to tell it apart from another (`itemKey`), to show it to somebody
 * (`title`, `author`, `url`), and to say how recent it is (`publishedAt`).
 * Everything a provider also happens to return — a description, a thumbnail, a
 * view count, a duration — is left behind at the adapter, because each one
 * would have to be stored, shown, translated, or sent to a model, and none of
 * them is needed to choose between two videos.
 *
 * The description in particular is deliberately absent: it is the longest
 * untrusted string a provider offers, and the less of it that travels, the
 * less there is to send to a model that is being asked to follow instructions.
 */
export type DiscoveryCandidate = {
  /**
   * What makes this the same thing next week.
   *
   * Provider-prefixed (`youtube:<videoId>`), so two sources cannot collide on
   * an id that means different things to each.
   */
  itemKey: string;
  title: string;
  author: string;
  /** Built by Koqentra from the id, never taken from the provider's answer. */
  url: string;
  /** Null when the source did not say. Never inferred. */
  publishedAt: Date | null;
};

/**
 * One thing chosen, and why.
 *
 * **The key rather than the candidate.** A selection names something from the
 * set that was offered; carrying a copy of the candidate would let a selection
 * describe something that was never a candidate, which is exactly the thing a
 * model asked to choose must not be able to do.
 */
export type DiscoverySelection = {
  itemKey: string;
  reason: string;
};

/**
 * What one run produced.
 *
 * **An empty `selections` is an ordinary outcome.** A worker that looked and
 * found nothing new has done its job, the same way a website worker whose page
 * did not change has done its job. `output` says so in words either way.
 */
export type DiscoveryRunResult = {
  selections: DiscoverySelection[];
  /** What a person reads on the run detail page. */
  output: string;
};
