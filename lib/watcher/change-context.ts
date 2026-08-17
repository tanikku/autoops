/**
 * How much of the page a model is ever shown.
 *
 * **A bound on the external text in one request, counted across both
 * excerpts.** Not a limit per excerpt: a change that rewrote half a page would
 * otherwise be two of these, and the number would mean nothing.
 *
 * It exists because the alternative has no ceiling. A watched page may be two
 * megabytes, and sending the whole of it — twice, before and after — on every
 * change would make cost and latency a property of somebody else's site.
 */
export const MAX_CHANGE_CONTEXT_CHARS = 24_000;

/** How much of the unchanged text before the change is kept, for orientation. */
export const CONTEXT_BEFORE_CHARS = 2_000;

/** How much of the unchanged text after it is kept, for the same reason. */
export const CONTEXT_AFTER_CHARS = 2_000;

/**
 * What stands in for the part of a change that did not fit.
 *
 * A fixed string so that two runs over the same input produce the same bytes,
 * and so that a reader of the excerpt can see that something is missing rather
 * than reading a truncated sentence as the whole of it.
 */
export const TRUNCATION_MARKER = "[...TRUNCATED...]";

/** The part of each version that a model is shown, and whether it is complete. */
export type WebsiteChangeContext = {
  previousExcerpt: string;
  currentExcerpt: string;
  /**
   * Whether a changed region had to be cut to fit.
   *
   * **Not "whether the model is seeing less than the page".** It never sees the
   * page — the surrounding text is bounded by design. This says the *change
   * itself* did not fit, which is the thing a reader has to be told about.
   */
  truncated: boolean;
};

/**
 * Reduces two versions of a page to the part that differs, plus its
 * surroundings.
 *
 * ```
 * common prefix │ what changed │ common suffix
 *      ↑ kept, bounded          ↑ kept, bounded
 * ```
 *
 * **Pure, and deterministic to the character.** No diff library, no model, no
 * clock, no randomness: the same two strings always produce the same pair of
 * excerpts. That matters twice over — a request that varied between runs would
 * make failures impossible to reproduce, and this is the one place where the
 * text of somebody else's website is turned into something sent to a model.
 *
 * The prefix and suffix are found by scanning from each end, which is not a
 * proper diff and is not trying to be. It finds one changed region rather than
 * several; a page with two edits far apart yields one span covering both, along
 * with whatever is between them. That is a worse excerpt than a real diff would
 * give and a much simpler thing to be sure of, and the cost falls on how much
 * text is sent rather than on whether the change is in it.
 *
 * **Nothing here decides what to do with the result.** It does not know what
 * the page was, where it came from, or who is watching it.
 */
export function buildWebsiteChangeContext(
  previous: string,
  current: string,
): WebsiteChangeContext {
  const prefix = commonPrefixLength(previous, current);
  const suffix = commonSuffixLength(previous, current, prefix);

  const previousChanged = previous.slice(prefix, previous.length - suffix);
  const currentChanged = current.slice(prefix, current.length - suffix);

  // The unchanged text either side is the same in both versions, so it is taken
  // once and shown with each excerpt — the model reads two self-contained
  // passages rather than having to stitch them together.
  const before = previous.slice(
    safeStart(previous, Math.max(0, prefix - CONTEXT_BEFORE_CHARS)),
    prefix,
  );
  const afterStart = previous.length - suffix;
  const after = previous.slice(
    afterStart,
    safeEnd(previous, Math.min(previous.length, afterStart + CONTEXT_AFTER_CHARS)),
  );

  // Both excerpts carry the surroundings, so the shared text is paid for twice.
  // What is left is what the two changed regions have to fit into.
  const budget = Math.max(
    0,
    MAX_CHANGE_CONTEXT_CHARS - 2 * (before.length + after.length),
  );
  const [previousBudget, currentBudget] = share(
    budget,
    previousChanged.length,
    currentChanged.length,
  );

  const shortenedPrevious = truncateMiddle(previousChanged, previousBudget);
  const shortenedCurrent = truncateMiddle(currentChanged, currentBudget);

  return {
    previousExcerpt: `${before}${shortenedPrevious.text}${after}`,
    currentExcerpt: `${before}${shortenedCurrent.text}${after}`,
    truncated: shortenedPrevious.truncated || shortenedCurrent.truncated,
  };
}

/**
 * Splits a budget between two regions, giving the slack to whichever needs it.
 *
 * An even split would cut a large change in half to make room for a small one
 * that already fits. Whichever fits inside its share takes only what it needs.
 */
function share(
  budget: number,
  previousLength: number,
  currentLength: number,
): [number, number] {
  if (previousLength + currentLength <= budget) {
    return [previousLength, currentLength];
  }

  const half = Math.floor(budget / 2);

  if (previousLength <= half) {
    return [previousLength, budget - previousLength];
  }

  if (currentLength <= half) {
    return [budget - currentLength, currentLength];
  }

  return [half, budget - half];
}

/**
 * Keeps both ends of a region that is too long, and says so in the middle.
 *
 * **Not the first N characters.** A change is frequently a small edit inside a
 * long block, and keeping only the beginning would show a model the part that
 * did not change while cutting the part that did. Both ends together at least
 * bracket it.
 */
function truncateMiddle(
  text: string,
  budget: number,
): { text: string; truncated: boolean } {
  if (text.length <= budget) {
    return { text, truncated: false };
  }

  const available = budget - TRUNCATION_MARKER.length;
  if (available <= 0) {
    // No room for both the marker and any text. Saying something is missing is
    // more use than a few characters of it.
    return { text: TRUNCATION_MARKER.slice(0, Math.max(0, budget)), truncated: true };
  }

  const headLength = Math.ceil(available / 2);
  const head = text.slice(0, safeEnd(text, headLength));
  const tail = text.slice(safeStart(text, text.length - (available - headLength)));

  return { text: `${head}${TRUNCATION_MARKER}${tail}`, truncated: true };
}

/**
 * How much the two share from the start.
 *
 * **Stops one character short of a split surrogate pair.** If the last matching
 * unit is a high surrogate, its partner cannot also have matched — the scan
 * would not have stopped there if it had — so including it would leave half a
 * character at the edge of an excerpt.
 */
function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let length = 0;

  while (length < limit && a.charCodeAt(length) === b.charCodeAt(length)) {
    length += 1;
  }

  return length > 0 && isHighSurrogate(a.charCodeAt(length - 1))
    ? length - 1
    : length;
}

/**
 * How much they share from the end, without reaching back into the prefix.
 *
 * **The cap is what keeps the two from overlapping.** `"aaaa"` and `"aaa"`
 * share three characters at the start and three at the end, which between them
 * account for more of the shorter string than it has; without the cap the
 * changed region would come out negative and the slices would be nonsense.
 */
function commonSuffixLength(a: string, b: string, prefix: number): number {
  const limit = Math.min(a.length, b.length) - prefix;
  let length = 0;

  while (
    length < limit &&
    a.charCodeAt(a.length - 1 - length) === b.charCodeAt(b.length - 1 - length)
  ) {
    length += 1;
  }

  // Symmetrically to the prefix: a low surrogate at the boundary has its
  // partner outside the suffix, so it is left out.
  return length > 0 && isLowSurrogate(a.charCodeAt(a.length - length))
    ? length - 1
    : length;
}

/**
 * An end index for `slice(0, n)` that never lands between a surrogate pair.
 *
 * **The contract is that no new invalid sequence is created**, not that grapheme
 * clusters survive: an emoji built from several code points can still be cut
 * between them. Going further would mean segmentation, which is a great deal of
 * machinery for text that is about to be summarised.
 */
function safeEnd(text: string, index: number): number {
  if (index <= 0) {
    return 0;
  }
  if (index >= text.length) {
    return text.length;
  }

  return isHighSurrogate(text.charCodeAt(index - 1)) &&
    isLowSurrogate(text.charCodeAt(index))
    ? index - 1
    : index;
}

/** A start index for `slice(n)` that never lands between a surrogate pair. */
function safeStart(text: string, index: number): number {
  if (index <= 0) {
    return 0;
  }
  if (index >= text.length) {
    return text.length;
  }

  return isLowSurrogate(text.charCodeAt(index)) &&
    isHighSurrogate(text.charCodeAt(index - 1))
    ? index + 1
    : index;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
