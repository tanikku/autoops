import type { DiscoveryCandidate } from "@/lib/discovery/types";

/**
 * Turning what a provider said into something the rest of Koqentra can use.
 *
 * **Not a parser.** Reading a provider's response — knowing which JSON field
 * holds an id, and what to do when the response is not a response at all — is
 * the adapter's job and stays there. What is here is the step after that: an
 * adapter has pulled four loose strings out of an answer, and these decide
 * whether those four strings amount to a candidate.
 *
 * **Pure.** No clock, no network, no database. That is what makes the rules
 * below testable as rules rather than as a provider's behaviour on a Tuesday.
 */

/** Where a YouTube video is watched. Koqentra builds this; it is never quoted. */
const YOUTUBE_WATCH_URL = "https://www.youtube.com/watch?v=";

/**
 * What an adapter hands over: four strings, any of which may be missing.
 *
 * Deliberately loose. An adapter that had to produce a valid candidate would
 * have to make the same judgements this file makes, in its own way, per
 * provider — and the whole point of one normalisation step is that "what counts
 * as usable" is decided once.
 */
export type RawDiscoveryItem = {
  id?: string | null;
  title?: string | null;
  author?: string | null;
  publishedAt?: string | null;
};

/**
 * The id, in a form that stays the same thing next week and cannot be confused
 * with another provider's.
 *
 * **The prefix is here from the start.** Two providers can hand out the same
 * id string meaning different things, and a stored key without a prefix cannot
 * be told apart later — adding one afterwards would mean rewriting every row
 * that already exists.
 */
export function youtubeItemKey(videoId: string): string {
  return `youtube:${videoId}`;
}

/** Where Koqentra sends somebody to watch it. */
export function youtubeWatchUrl(videoId: string): string {
  return `${YOUTUBE_WATCH_URL}${videoId}`;
}

/**
 * A date, or nothing.
 *
 * **A bad timestamp drops the timestamp, not the candidate.** When a video was
 * published is useful and not essential: a candidate with an unreadable date is
 * still a video somebody might want, and refusing it would throw away a result
 * over a field nothing depends on. Absent and unreadable are the same answer
 * because nothing downstream can act differently on them.
 */
export function readPublishedAt(value: string | null | undefined): Date | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const at = new Date(value);

  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * One raw item as a candidate, or null when it is not one.
 *
 * **Three things are required, and each for a different reason.** Without an
 * id there is no way to say this is the same video tomorrow, so it could be
 * chosen twice and nothing would notice. Without a title there is nothing to
 * show and nothing for a model to judge. Without an author the rule about not
 * taking two videos from the same person cannot be applied, and a run would
 * quietly return five from one channel.
 *
 * **The URL is built, never taken.** A provider returning a link is a provider
 * choosing where Koqentra sends somebody; constructing it from the id means the
 * address is always the one the id names, whatever else came back in the
 * answer.
 *
 * Whitespace-only counts as missing: a title of three spaces is not a title,
 * and treating it as one would put a blank line in front of a reader.
 */
export function toDiscoveryCandidate(
  item: RawDiscoveryItem,
): DiscoveryCandidate | null {
  const videoId = typeof item.id === "string" ? item.id.trim() : "";
  const title = typeof item.title === "string" ? item.title.trim() : "";
  const author = typeof item.author === "string" ? item.author.trim() : "";

  if (videoId === "" || title === "" || author === "") {
    return null;
  }

  return {
    itemKey: youtubeItemKey(videoId),
    title,
    author,
    url: youtubeWatchUrl(videoId),
    publishedAt: readPublishedAt(item.publishedAt),
  };
}

/**
 * Every usable candidate from a batch, in the order they arrived.
 *
 * **Unusable items are dropped, not fatal.** A provider returning twenty items
 * of which three are unreadable has answered the question; refusing the whole
 * answer over three would turn a good run into a failed one. A response that
 * could not be read *at all* is a different event, and it is the adapter that
 * raises it.
 *
 * **Order is kept.** The provider was asked for newest first; re-sorting here
 * would silently override what was asked for.
 */
export function toDiscoveryCandidates(
  items: readonly RawDiscoveryItem[],
): DiscoveryCandidate[] {
  const candidates: DiscoveryCandidate[] = [];

  for (const item of items) {
    const candidate = toDiscoveryCandidate(item);

    if (candidate !== null) {
      candidates.push(candidate);
    }
  }

  return candidates;
}
