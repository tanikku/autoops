import "server-only";

import type { DiscoveryProvider } from "@/lib/discovery/provider";
import { isDiscoverySourceKind } from "@/lib/discovery/types";
import { YouTubeDiscoveryProvider } from "@/lib/discovery/youtube";

/**
 * Turning a stored source name into something that can be asked, or into the
 * reason it cannot be.
 *
 * **Unlike `createAIProvider`, there is no stand-in.** A missing
 * `ANTHROPIC_API_KEY` falls back to a provider that answers with a fixed string,
 * and the danger of that is written down where it happens: the run is recorded
 * as a success and nothing downstream can tell. A discovery worker has no
 * equivalent — a fabricated list of videos would be five links to nothing,
 * recorded as a successful run and possibly emailed. **So this fails closed
 * instead**, and answers that it is unavailable.
 *
 * **Availability is answered without asking anybody.** Nothing here makes a
 * request: the question is whether this deployment is configured to reach a
 * source, and a network call to find that out would bill a quota to answer a
 * question about the environment.
 *
 * **Nothing calls this yet.** `routineKinds` does not contain `discovery`, so no
 * worker reaches execution and no execution reaches here.
 */

/**
 * Why a source cannot be asked.
 *
 * Two reasons because they lead somewhere different: one is a deployment that
 * needs a variable set, the other is a stored row naming a provider this version
 * does not have.
 */
export type DiscoveryProviderUnavailable =
  /** The stored source is not one this version knows. */
  | "unknown-source"
  /** The source is known and this deployment has no key for it. */
  | "not-configured";

export type DiscoveryProviderAvailability =
  | { available: true; provider: DiscoveryProvider }
  | { available: false; reason: DiscoveryProviderUnavailable };

/**
 * The key for the one provider that exists.
 *
 * **Read per call rather than once per process**, the same choice
 * `lib/notify/email.ts` makes and for the same reason: nothing is built at
 * startup here, so there is nowhere for an early read to live, and a deployment
 * that adds the variable starts working on restart rather than on the next
 * code change.
 *
 * **Missing and blank are the same answer.** A whitespace key is as unusable as
 * an absent one, and telling them apart would only decide which of two identical
 * failures gets a different name.
 *
 * **Nothing requires this at boot.** An unset `YOUTUBE_API_KEY` makes discovery
 * unavailable; it does not stop the application starting, and it cannot, because
 * nothing reads this during startup.
 */
function youtubeApiKey(): string | null {
  const key = process.env.YOUTUBE_API_KEY?.trim();

  return key ? key : null;
}

/**
 * A provider for this source, or why there is not one.
 *
 * **`source` arrives as a plain string** because that is what the column holds.
 * Narrowing it here rather than upstream is what makes an unrecognised stored
 * value something to report instead of something to crash on.
 */
export function createDiscoveryProvider(
  source: string,
): DiscoveryProviderAvailability {
  if (!isDiscoverySourceKind(source)) {
    return { available: false, reason: "unknown-source" };
  }

  const apiKey = youtubeApiKey();

  if (apiKey === null) {
    return { available: false, reason: "not-configured" };
  }

  return { available: true, provider: new YouTubeDiscoveryProvider(apiKey) };
}
