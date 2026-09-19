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
 * What a discovery worker records when it chose nothing.
 *
 * **It says nothing was found *for this search*, and stops there.** A run that
 * chose nothing has several ordinary causes that it cannot tell apart — the
 * source returned nothing, everything it returned had already been chosen, the
 * model judged none of it worth recommending, or two candidates shared an
 * author and only one could be kept. "There is nothing new" would be a claim
 * about the world; this is a statement about the run.
 *
 * **The only discovery output that is Koqentra's own.** A run that chose
 * something writes the titles, authors, addresses and reasons that belong to
 * the run, and none of that is ours to reword — see
 * `formatRunOutputForDisplay`.
 */
export const DISCOVERY_NO_SELECTION_OUTPUT =
  "No recommendations were found for this search.";

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
 * The same, for discovery, and deliberately a second map rather than one
 * shared one.
 *
 * **Which kind wrote a sentence is half of what makes the match safe.** The
 * lookup below asks the map belonging to the worker's own kind, so a discovery
 * worker cannot have a website sentence rewritten for it and a prompt worker
 * cannot have either. One map keyed by string alone would drop that half and
 * leave only "the text matched exactly" standing.
 */
const discoverySystemOutputs = new Map<string, TranslationKey>([
  [DISCOVERY_NO_SELECTION_OUTPUT, "run.system.discoveryNoSelection"],
]);

/** The sentences one kind of worker writes for itself. None, for a prompt worker. */
function systemOutputsFor(
  kind: RoutineKind | null,
): Map<string, TranslationKey> | null {
  if (kind === "website") {
    return websiteSystemOutputs;
  }

  return kind === "discovery" ? discoverySystemOutputs : null;
}

/**
 * What to show for a run's output, in the language the account reads.
 *
 * @param output what was stored, unchanged
 * @param kind the worker's kind, or null when this version cannot read it —
 *   treated as a kind that writes nothing of its own, because translating on a
 *   value nobody can account for is the guess this boundary exists to refuse
 * @param language the account's current setting, not the one in force when the
 *   run happened
 *
 * @returns the translated sentence for the three AutoOps writes, and the
 *   stored string itself for everything else — including a website worker's AI
 *   summary and a discovery worker's list of what it chose, both of which are
 *   the worker's product rather than ours.
 */
export function formatRunOutputForDisplay(
  output: string,
  kind: RoutineKind | null,
  language: string,
): string {
  const systemOutputs = systemOutputsFor(kind);

  if (systemOutputs === null) {
    return output;
  }

  const key = systemOutputs.get(output);

  return key ? t(language, key) : output;
}
