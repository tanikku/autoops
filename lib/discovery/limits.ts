/**
 * The numbers a discovery run is bounded by.
 *
 * **Every one of these was decided rather than defaulted**, and the reason is
 * beside it. They live together because the form, the adapter and the selection
 * step each need some of them, and a bound that appears in two files eventually
 * appears as two different numbers.
 *
 * Nothing here is read yet: the form validation that will enforce them and the
 * adapter that will obey them are the next phase. Defining them now is what
 * lets that phase reference a decision instead of making one.
 */

/**
 * How long a search phrase may be.
 *
 * Matched to `creatorAnalysisLimits.contentTitle`, which is the other place
 * Koqentra bounds a short human-written line. A search that needs more than
 * three hundred characters is not a search.
 */
export const DISCOVERY_QUERY_MAX_CHARS = 300;

/**
 * How many things a run picks when nobody says otherwise.
 *
 * Five, because that is what the request this feature exists for asked for —
 * enough to choose from, few enough to read in a notification.
 */
export const DISCOVERY_DEFAULT_MAX_RESULTS = 5;

/**
 * The most a run may pick, whatever the owner sets.
 *
 * **A bound on the output rather than on the ambition.** Ten items is already
 * more than a daily message can be read for; past that the list stops being a
 * recommendation and becomes a feed, which is a different product.
 */
export const DISCOVERY_MAX_RESULTS_CEILING = 10;

/**
 * How many candidates a run may look at before choosing.
 *
 * **Not the owner's to set**, which is why it is not a column. It is the cost
 * of one run — the size of the provider request and the amount of text a model
 * is shown — and both of those are Koqentra's concern rather than a preference.
 *
 * Twenty-five leaves room for duplicates and same-author candidates to be
 * dropped and still have enough left to choose five from.
 */
export const DISCOVERY_MAX_CANDIDATES = 25;

/**
 * How far back "new" reaches.
 *
 * Thirty days rather than seven: a worker on a daily cadence needs candidates
 * to still be there after the obvious ones have been taken, and a week's window
 * empties out. This bounds the provider request, so it is a decision about what
 * is asked for rather than a filter applied afterwards.
 */
export const DISCOVERY_PUBLISHED_WITHIN_DAYS = 30;
