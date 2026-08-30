import { t, type TranslationKey } from "@/lib/i18n";
import type { RoutineKind } from "@/types";

/**
 * Reading a run's output on a screen, when some of it is AutoOps talking.
 *
 * **`RunHistory.output` holds two different kinds of thing.** Most of it is the
 * worker's own product — what a model wrote, in whatever language the person
 * asked for it in. A small, closed set of sentences is not that: they are
 * AutoOps reporting on itself, written into the column because a website worker
 * that found nothing to say still has to say something. The first kind is the
 * account's material and must never be translated. The second is interface
 * copy that happens to be stored, and reads wrong in a Japanese dashboard.
 *
 * **This translates at display time and writes nothing.** The stored string
 * stays exactly as it was, which is what lets a run recorded while the account
 * read English appear in Japanese after the setting changes — and is why there
 * is no migration here, and nothing to backfill.
 *
 * **The whole safety of it is the two conditions below**: the worker has to be
 * a `website` worker, and the output has to be *exactly* one of the known
 * sentences. Anything looser — a prefix, a substring, a pattern — would let a
 * prompt worker's output be rewritten by us, and a prompt is something the
 * account writes.
 */

/**
 * What a website worker's first successful check records.
 *
 * **Defined here and imported by the writer**, rather than copied. Two spellings
 * of the same sentence would not fail anything: the write would keep working,
 * the match would quietly stop, and the message would go back to English with
 * no test to notice. One definition makes that impossible.
 */
export const WEBSITE_BASELINE_OUTPUT =
  "Website baseline is not established yet.";

/** What a website worker records when the page it watches had not changed. */
export const WEBSITE_UNCHANGED_OUTPUT = "Website content has not changed.";

/**
 * The closed set, and the words for each.
 *
 * A `Map` rather than a chain of comparisons so that adding a sentence is a
 * line, and so that "is this one of ours" is a single lookup on the exact
 * string. **Only successful website outputs belong here** — a failure's wording
 * lives in `errorMessage`, where several sentences carry a host, a status code
 * or a byte count inside them and could not be matched this way at all.
 */
const websiteSystemOutputs = new Map<string, TranslationKey>([
  [WEBSITE_BASELINE_OUTPUT, "run.system.websiteBaseline"],
  [WEBSITE_UNCHANGED_OUTPUT, "run.system.websiteUnchanged"],
]);

/**
 * What to show for a run's output, in the language the account reads.
 *
 * @param output what was stored, unchanged
 * @param kind the worker's kind, or null when this version cannot read it —
 *   treated as "not a website worker", because translating on a value nobody
 *   can account for is the guess this boundary exists to refuse
 * @param language the account's current setting, not the one in force when the
 *   run happened
 *
 * @returns the translated sentence for the two AutoOps writes, and the stored
 *   string itself for everything else — including a website worker's AI
 *   summary, which is the worker's product rather than ours.
 */
export function formatRunOutputForDisplay(
  output: string,
  kind: RoutineKind | null,
  language: string,
): string {
  if (kind !== "website") {
    return output;
  }

  const key = websiteSystemOutputs.get(output);

  return key ? t(language, key) : output;
}
