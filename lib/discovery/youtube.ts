import "server-only";

import { fetchTrustedJson } from "@/lib/discovery/http";
import {
  DISCOVERY_MAX_CANDIDATES,
  DISCOVERY_PUBLISHED_WITHIN_DAYS,
} from "@/lib/discovery/limits";
import { type RawDiscoveryItem, toDiscoveryCandidates } from "@/lib/discovery/normalize";
import { DiscoveryProviderError, type DiscoveryProvider } from "@/lib/discovery/provider";
import type { DiscoveryCandidate, DiscoveryQuery } from "@/lib/discovery/types";

/**
 * Asking YouTube what has been published lately.
 *
 * **One endpoint, one page, and no second call.** `search.list` answers with
 * everything needed to choose between videos, and `videos.list` — which is what
 * would tell a duration, and therefore what would tell a Short from anything
 * else — is deliberately not called. Shorts are not distinguished, which is a
 * decision rather than an omission: it would double the request count of every
 * run to apply a rule nobody asked for.
 *
 * **Nothing here decides anything about a run.** It asks, it makes candidates
 * out of the answer, and it stops. What is new, what is worth choosing and what
 * gets written down are three other modules' questions.
 */

/** The one path this provider requests. */
const SEARCH_PATH = "/youtube/v3/search";

/**
 * The only part of a search result this asks for.
 *
 * **A `fields` mask rather than a filter applied afterwards.** The description
 * is the longest untrusted string YouTube offers and the one thing most likely
 * to be written at a model rather than at a reader; asking for a response that
 * does not contain it means there is no copy of it in this process to leak,
 * log, or forget to strip. Thumbnails, live-broadcast state and the channel id
 * are absent for the smaller reason: nothing chooses between two videos with
 * them.
 */
const RESPONSE_FIELDS = "items(id/videoId,snippet(title,channelTitle,publishedAt))";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

/** What `search.list` answers with, as much of it as is read. */
type SearchItem = {
  id?: { videoId?: unknown } | null;
  snippet?: { title?: unknown; channelTitle?: unknown; publishedAt?: unknown } | null;
};

/** A string, or nothing — YouTube's own answer is not assumed to be typed. */
function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * The window a search reaches back over, as the API wants it written.
 *
 * Computed from the clock the provider was given rather than read from
 * `Date.now()` inside the request, so what was asked for is reproducible in a
 * test without moving the machine's clock.
 */
function publishedAfter(now: Date): string {
  return new Date(
    now.getTime() - DISCOVERY_PUBLISHED_WITHIN_DAYS * MILLISECONDS_PER_DAY,
  ).toISOString();
}

/**
 * Turns the documented shape into the loose one `toDiscoveryCandidates` judges.
 *
 * **No judgement happens here.** Whether four loose strings amount to a
 * candidate is decided once, in `lib/discovery/normalize.ts`, so a second
 * provider cannot decide it differently.
 */
function toRawItem(item: SearchItem): RawDiscoveryItem {
  return {
    id: text(item.id?.videoId),
    title: text(item.snippet?.title),
    author: text(item.snippet?.channelTitle),
    publishedAt: text(item.snippet?.publishedAt),
  };
}

export class YouTubeDiscoveryProvider implements DiscoveryProvider {
  readonly source = "youtube" as const;

  /**
   * **The key is held, never re-read and never logged.** The clock is a
   * parameter for the same reason `advanceSchedule` is told what time it is:
   * an answer that depends on when it was asked is not testable as a rule.
   */
  constructor(
    private readonly apiKey: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async search(query: DiscoveryQuery): Promise<DiscoveryCandidate[]> {
    const body = await fetchTrustedJson(SEARCH_PATH, {
      part: "snippet",
      // **Videos only.** A channel or a playlist has no `videoId`, so one
      // arriving would be dropped by normalisation — asking for none is
      // cheaper than paying for results that cannot be used.
      type: "video",
      // Newest first, which is what makes "the last thirty days" a window
      // rather than a filter over whatever relevance returned.
      order: "date",
      q: query.query,
      publishedAfter: publishedAfter(this.now()),
      // **Never more than the platform's ceiling, whatever was asked for.**
      // `maxCandidates` is Koqentra's own number rather than the owner's, and
      // this is where it stops being advisory.
      maxResults: String(Math.min(query.maxCandidates, DISCOVERY_MAX_CANDIDATES)),
      fields: RESPONSE_FIELDS,
      key: this.apiKey,
    });

    // **One page.** `nextPageToken` is not read and no second request is made:
    // the window and the candidate ceiling together decide how much a run looks
    // at, and paging would make that the provider's decision instead.
    if (typeof body !== "object" || body === null) {
      throw new DiscoveryProviderError("unreadable");
    }

    const items = (body as { items?: unknown }).items;

    // **An absent `items` is an empty search, not a broken answer.** YouTube
    // omits the key when nothing matched, and treating that as a failure would
    // record a failed run for a search that worked and found nothing.
    if (items === undefined || items === null) {
      return [];
    }

    if (!Array.isArray(items)) {
      throw new DiscoveryProviderError("unreadable");
    }

    return toDiscoveryCandidates(
      (items as SearchItem[]).map((item) =>
        toRawItem(typeof item === "object" && item !== null ? item : {}),
      ),
    );
  }
}
