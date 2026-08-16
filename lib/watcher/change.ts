import type { NormalizedWebsiteContent } from "@/lib/watcher/normalize";
import type { WebsiteSnapshot } from "@/types";

/**
 * What a page turned out to be, compared with what was expected.
 *
 * Three answers and no more. **`initial` is not a kind of change** — nothing
 * has been watched yet, so there is nothing a reader could be told about, and
 * anything that treats it as a change would announce one the first time a
 * worker ran.
 */
export type WebsiteChangeState =
  | { state: "initial" }
  | { state: "unchanged" }
  | { state: "changed" };

/**
 * The part of a stored snapshot a comparison needs.
 *
 * A `Pick` of the stored row rather than a type of its own, the same way
 * `DueWorker` is: two descriptions of the same columns would eventually
 * disagree about them.
 */
export type WebsiteBaseline = Pick<
  WebsiteSnapshot,
  "normalizedContent" | "contentHash"
>;

/**
 * Compares a page just read against the baseline held for it.
 *
 * **Pure, and it does not reach the database.** The baseline is passed in
 * rather than fetched, so this decides nothing about when a snapshot is read,
 * and — more importantly — nothing about when one is written. **A change
 * detected here does not advance anything**: doing that at the moment of
 * detection would consume the change, and if the work it triggers then failed,
 * the reader would never hear about it and the next run would find nothing to
 * report. Advancing the baseline belongs to whatever succeeds afterwards.
 *
 * **Both the digest and the text have to agree for a page to be unchanged.**
 * The digest alone would be enough in every ordinary case, and comparing the
 * text as well costs a string comparison that almost always stops at the first
 * character. What it buys is the direction of the mistake: if the two ever
 * disagree — a truncated column, a digest written by an older normalizer — this
 * reports a change and somebody sees an extra summary, rather than reporting
 * nothing and quietly watching a page it is no longer really comparing.
 *
 * That asymmetry is the rule the whole layer is built on: **an extra report is
 * an annoyance, a missed one is the feature not working.**
 */
export function detectWebsiteChange(
  baseline: WebsiteBaseline | null,
  current: NormalizedWebsiteContent,
): WebsiteChangeState {
  if (baseline === null) {
    return { state: "initial" };
  }

  const same =
    baseline.contentHash === current.contentHash &&
    baseline.normalizedContent === current.normalizedContent;

  return same ? { state: "unchanged" } : { state: "changed" };
}
