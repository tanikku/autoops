import "server-only";

import type { AIProvider } from "@/lib/ai/provider";
import { createDiscoveryProvider } from "@/lib/discovery/factory";
import { DISCOVERY_MAX_CANDIDATES } from "@/lib/discovery/limits";
import { isDiscoveryProviderError } from "@/lib/discovery/provider";
import { findSeenKeys, getDiscoverySource } from "@/lib/discovery/repository";
import {
  isInvalidDiscoverySelection,
  selectDiscoveryItems,
} from "@/lib/discovery/select";
import type { DiscoveryCandidate, DiscoverySelection } from "@/lib/discovery/types";
import { DISCOVERY_NO_SELECTION_OUTPUT } from "@/lib/run-display";

/**
 * What a discovery worker does between taking the lease and recording what
 * happened.
 *
 * ```
 * source → provider → candidates → what has been seen → the model → what to keep
 * ```
 *
 * **It lives here rather than in `lib/runs.ts` because none of it is about
 * running a worker.** That file owns the lease, the run row, the release and
 * the notification, and it owns them for all three kinds; what a discovery run
 * consists of is this module's, the same way `lib/watcher/` owns what a website
 * run consists of. The one thing it hands back is a decision about what to
 * write down.
 *
 * **Nothing here writes.** Every step reads — a source, a provider, a history,
 * a model — and the answer is a value the caller persists inside its own
 * transaction. That is what keeps a provider call and a model call out of a
 * database transaction, which is the property the whole ordering exists for.
 */

/**
 * What a run turned out to be, before anything about it is stored.
 *
 * **`selected` is what gets written down and `output` is what gets read**, and
 * they are produced together so that the row and the list cannot disagree. A
 * failure carries neither: its `errorMessage` is a fixed sentence, chosen from
 * the closed set below.
 */
export type DiscoveryExecution =
  | {
      status: "completed";
      /** What to record as seen. Empty is an ordinary outcome. */
      selected: DiscoveryCandidate[];
      /** The reasons, in the same order, for the run's own output. */
      selections: DiscoverySelection[];
      output: string;
    }
  | { status: "failed"; errorMessage: string };

/**
 * Why a discovery run failed, in words that are stored.
 *
 * **Fixed sentences, and none of them carries anything from outside.** Not the
 * search, not a title, not the provider's answer, not a status code, and never
 * the key — a discovery request puts the key in its URL, so a failure that
 * quoted anything about the request would be a failure that stored a secret.
 * Whatever detail exists goes to the log, exactly as it does for a website run.
 */
const NO_SOURCE_CONFIGURED = "This worker has no search configured.";
const SOURCE_UNAVAILABLE = "Searching is not available for this worker.";
const SEARCH_FAILED = "The search could not be completed.";
const SELECTION_FAILED = "Choosing what to recommend failed.";

/**
 * One line per thing chosen, and no labels.
 *
 * **Four facts and no words of Koqentra's own**, which is what keeps this out
 * of `formatRunOutputForDisplay`'s business: a title, an author, an address and
 * a reason are all the run's own material, so a list of them reads the same in
 * every language and needs no translation. Labelling the parts would put
 * English into a Japanese account's output, and translating the labels would
 * mean writing the row in a language read at execution time rather than at
 * reading time.
 *
 * **Plain text, because that is what the column holds and what every reader
 * does with it.** The execution page renders `output` inside a `<pre>` and the
 * email sends it as `text/plain`; nothing on either path interprets markup, and
 * nothing here produces any.
 */
function formatSelections(
  selections: readonly DiscoverySelection[],
  byKey: Map<string, DiscoveryCandidate>,
): string {
  return selections
    .map((selection) => {
      const candidate = byKey.get(selection.itemKey);

      // Unreachable: a selection that survived validation names a candidate.
      // Skipping rather than throwing keeps a formatting detail from deciding
      // whether a finished run counts as one.
      if (candidate === undefined) {
        return "";
      }

      return [
        candidate.title,
        candidate.author,
        candidate.url,
        selection.reason,
      ].join("\n");
    })
    .filter((entry) => entry !== "")
    .join("\n\n");
}

/** What the caller supplies so that this module reaches no globals of its own. */
export type DiscoveryExecutionDeps = {
  /** The model that chooses. Handed in so the pipeline is testable without one. */
  aiProvider: AIProvider;
};

/**
 * Runs one discovery worker and says what should be recorded.
 *
 * **Every zero is a completed run.** A source with nothing in it, a source
 * whose every result has already been recommended, a model that chose none of
 * what was left, and two candidates from one author where only one could be
 * kept all end the same way: a finished run that says nothing was found. None
 * of them is a failure, and none of them is padded out to reach the number the
 * owner asked for — a recommendation nobody stands behind is worse than a short
 * list.
 *
 * **The model is asked only when there is something to ask about.** A run with
 * no candidates left after the history is subtracted returns without a request,
 * which is both cheaper and the honest shape: there was nothing to choose from.
 */
export async function executeDiscovery(
  routineId: string,
  userId: string,
  deps: DiscoveryExecutionDeps,
): Promise<DiscoveryExecution> {
  // Scoped to the owner through the routine — a source has no owner column of
  // its own, and this is the only thing that says who it belongs to.
  const source = await getDiscoverySource(routineId, userId);

  if (source === null) {
    // **Not a fallback to anything.** A discovery worker with no search
    // configured has nothing to do, and guessing one would be answering a
    // question nobody asked. Nothing is created and nothing is repaired: the
    // state should not exist, and the answer to finding it is to change nothing.
    console.error("[worker] discovery run has no source configured", routineId);
    return { status: "failed", errorMessage: NO_SOURCE_CONFIGURED };
  }

  const availability = createDiscoveryProvider(source.source);

  if (!availability.available) {
    // **No stand-in, ever.** A fabricated list of videos would be recorded as a
    // successful run and could be emailed; unlike a prompt worker's fixed
    // sentence, there is nobody it would be obviously wrong to.
    console.error(
      `[worker] discovery run cannot reach its source — reason=${availability.reason}`,
      routineId,
    );
    return { status: "failed", errorMessage: SOURCE_UNAVAILABLE };
  }

  let candidates: DiscoveryCandidate[];
  try {
    candidates = await availability.provider.search({
      source: availability.provider.source,
      query: source.query,
      maxCandidates: DISCOVERY_MAX_CANDIDATES,
    });
  } catch (error) {
    // The reason is logged and the stored sentence is fixed. **Nothing about
    // the request is logged either** — see `DiscoveryProviderError`, which
    // carries a reason and nothing else for exactly this call site.
    console.error(
      "[worker] discovery search failed —",
      isDiscoveryProviderError(error) ? error.reason : "unknown",
      "—",
      routineId,
    );
    return { status: "failed", errorMessage: SEARCH_FAILED };
  }

  if (candidates.length === 0) {
    return completedWithNothing();
  }

  // **The whole history, asked about these candidates.** Not the most recent N
  // rows: a channel that publishes weekly is surfaced by the same search every
  // day, and a window would eventually let something chosen months ago come
  // back as new. See `findSeenKeys`.
  let seen: Set<string>;
  try {
    seen = await findSeenKeys(
      routineId,
      userId,
      candidates.map((candidate) => candidate.itemKey),
    );
  } catch (error) {
    console.error("[worker] discovery history could not be read", routineId, error);
    return { status: "failed", errorMessage: SEARCH_FAILED };
  }

  const fresh = candidates.filter((candidate) => !seen.has(candidate.itemKey));

  if (fresh.length === 0) {
    // Everything found has been recommended before. A finished run with nothing
    // to say, and **no model is asked**: there is nothing to choose from.
    return completedWithNothing();
  }

  let selections: DiscoverySelection[];
  try {
    selections = await selectDiscoveryItems(deps.aiProvider, {
      query: source.query,
      maxResults: source.maxResults,
      candidates: fresh,
    });
  } catch (error) {
    // **Both halves of this are failures, and they are logged apart.** An
    // answer that never arrived is the provider's; an answer that arrived and
    // could not be used is the model's. Neither reaches the row, which gets one
    // fixed sentence.
    console.error(
      "[worker] discovery selection failed —",
      isInvalidDiscoverySelection(error) ? "unusable-answer" : "provider",
      "—",
      routineId,
    );
    return { status: "failed", errorMessage: SELECTION_FAILED };
  }

  if (selections.length === 0) {
    // A valid answer that chose nothing, or one whose every choice shared an
    // author with an earlier one. Both are finished runs.
    return completedWithNothing();
  }

  const byKey = new Map(fresh.map((candidate) => [candidate.itemKey, candidate]));

  return {
    status: "completed",
    // **In the order the model ranked them**, which is the order the list is
    // read in and the order they are written down in.
    selected: selections
      .map((selection) => byKey.get(selection.itemKey))
      .filter((candidate): candidate is DiscoveryCandidate => candidate !== undefined),
    selections,
    output: formatSelections(selections, byKey),
  };
}

/** A finished run that chose nothing, which is an outcome rather than an absence. */
function completedWithNothing(): DiscoveryExecution {
  return {
    status: "completed",
    selected: [],
    selections: [],
    // Stored in English and translated when shown, exactly as the two website
    // sentences are — see `lib/run-display.ts`.
    output: DISCOVERY_NO_SELECTION_OUTPUT,
  };
}
