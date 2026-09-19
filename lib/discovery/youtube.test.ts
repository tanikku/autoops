import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DISCOVERY_MAX_CANDIDATES,
  DISCOVERY_PUBLISHED_WITHIN_DAYS,
} from "@/lib/discovery/limits";
import { isDiscoveryProviderError } from "@/lib/discovery/provider";
import type { DiscoveryQuery } from "@/lib/discovery/types";
import { YouTubeDiscoveryProvider } from "@/lib/discovery/youtube";

/**
 * What is asked of YouTube, and what is made of the answer.
 *
 * **Nothing here reaches YouTube.** `fetch` is replaced for the whole file and
 * restored afterwards, so a test that forgot to arrange an answer fails on a
 * missing mock rather than on a request leaving the machine.
 *
 * The provider is given a fixed clock, so what `publishedAfter` asked for is a
 * value a test can state rather than a moving one.
 */

const API_KEY = "yt_test_key_not_a_real_one";
const NOW = new Date("2026-09-19T00:00:00.000Z");
/** Thirty days before `NOW`, written the way the API is asked for it. */
const WINDOW_START = "2026-08-20T00:00:00.000Z";

const fetchMock = vi.fn();
const realFetch = globalThis.fetch;

function provider() {
  return new YouTubeDiscoveryProvider(API_KEY, () => NOW);
}

function query(overrides: Partial<DiscoveryQuery> = {}): DiscoveryQuery {
  return {
    source: "youtube",
    query: "ハリネズミ 飼い方",
    maxCandidates: DISCOVERY_MAX_CANDIDATES,
    ...overrides,
  };
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: { videoId: "abc123" },
    snippet: {
      title: "ハリネズミの飼い方",
      channelTitle: "もふもふチャンネル",
      publishedAt: "2026-09-18T09:00:00Z",
    },
    ...overrides,
  };
}

function answers(body: unknown) {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    type: "basic",
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
        controller.close();
      },
    }),
  } as unknown as Response);
}

function requestedUrl(): URL {
  return new URL(String(fetchMock.mock.calls[0][0]));
}

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  answers({ items: [] });
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("the request", () => {
  it("asks search.list on the trusted host", async () => {
    await provider().search(query());

    const url = requestedUrl();

    expect(url.origin).toBe("https://www.googleapis.com");
    expect(url.pathname).toBe("/youtube/v3/search");
  });

  it("asks for videos, newest first, for the configured phrase", async () => {
    await provider().search(query({ query: "hedgehog care" }));

    const params = requestedUrl().searchParams;

    expect(params.get("type")).toBe("video");
    expect(params.get("order")).toBe("date");
    expect(params.get("q")).toBe("hedgehog care");
    expect(params.get("part")).toBe("snippet");
  });

  it("asks only as far back as the window reaches", async () => {
    expect(DISCOVERY_PUBLISHED_WITHIN_DAYS).toBe(30);

    await provider().search(query());

    expect(requestedUrl().searchParams.get("publishedAfter")).toBe(WINDOW_START);
  });

  it("asks for at most the candidate ceiling", async () => {
    await provider().search(query());

    expect(requestedUrl().searchParams.get("maxResults")).toBe(
      String(DISCOVERY_MAX_CANDIDATES),
    );
  });

  /** `maxCandidates` is Koqentra's number; this is where it stops being advisory. */
  it("never asks for more than the ceiling, whatever it was handed", async () => {
    await provider().search(query({ maxCandidates: 500 }));

    expect(requestedUrl().searchParams.get("maxResults")).toBe("25");
  });

  it("asks for fewer when fewer were wanted", async () => {
    await provider().search(query({ maxCandidates: 8 }));

    expect(requestedUrl().searchParams.get("maxResults")).toBe("8");
  });

  /**
   * **The description is not filtered out later; it is never asked for.** There
   * is no copy of it in this process to leak, log, or forget to strip.
   */
  it("asks for four fields and not the description", async () => {
    await provider().search(query());

    const fields = requestedUrl().searchParams.get("fields") ?? "";

    expect(fields).toBe("items(id/videoId,snippet(title,channelTitle,publishedAt))");
    expect(fields).not.toContain("description");
  });

  it("carries the key as the API takes it", async () => {
    await provider().search(query());

    expect(requestedUrl().searchParams.get("key")).toBe(API_KEY);
  });

  /** One page. The window and the ceiling decide how much a run looks at. */
  it("makes one request and never pages", async () => {
    answers({ items: [item()], nextPageToken: "CAUQAA" });

    await provider().search(query());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestedUrl().searchParams.get("pageToken")).toBeNull();
  });

  /** Shorts are not distinguished: `videos.list` is never called. */
  it("never asks videos.list for a duration", async () => {
    answers({ items: [item()] });

    await provider().search(query());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestedUrl().pathname).not.toContain("/videos");
  });
});

describe("what is made of the answer", () => {
  it("turns an item into a candidate", async () => {
    answers({ items: [item()] });

    const [candidate] = await provider().search(query());

    expect(candidate).toEqual({
      itemKey: "youtube:abc123",
      title: "ハリネズミの飼い方",
      author: "もふもふチャンネル",
      url: "https://www.youtube.com/watch?v=abc123",
      publishedAt: new Date("2026-09-18T09:00:00Z"),
    });
  });

  /** The address is built from the id, never quoted from the answer. */
  it("builds the watch URL itself, ignoring any the answer offers", async () => {
    answers({
      items: [{ ...item(), url: "https://elsewhere.example/watch?v=abc123" }],
    });

    const [candidate] = await provider().search(query());

    expect(candidate.url).toBe("https://www.youtube.com/watch?v=abc123");
  });

  it("trims a title and an author", async () => {
    answers({
      items: [
        item({
          snippet: {
            title: "  spaced out  ",
            channelTitle: "  a channel  ",
            publishedAt: "2026-09-18T09:00:00Z",
          },
        }),
      ],
    });

    const [candidate] = await provider().search(query());

    expect(candidate.title).toBe("spaced out");
    expect(candidate.author).toBe("a channel");
  });

  it("keeps the order the answer arrived in", async () => {
    answers({
      items: [
        item({ id: { videoId: "first" } }),
        item({ id: { videoId: "second" } }),
      ],
    });

    const keys = (await provider().search(query())).map((c) => c.itemKey);

    expect(keys).toEqual(["youtube:first", "youtube:second"]);
  });

  /** A bad timestamp drops the timestamp, not the video. */
  it.each([
    ["unreadable", "not a date"],
    ["absent", undefined],
    ["blank", "   "],
    ["not a string", 1_726_000_000],
  ])("reads a publication date that is %s as null", async (_label, publishedAt) => {
    answers({
      items: [
        item({
          snippet: {
            title: "still a video",
            channelTitle: "a channel",
            publishedAt,
          },
        }),
      ],
    });

    const [candidate] = await provider().search(query());

    expect(candidate.publishedAt).toBeNull();
    expect(candidate.itemKey).toBe("youtube:abc123");
  });

  /**
   * **Unusable items are dropped, not fatal.** Twenty results of which three
   * are unreadable is still an answer; refusing all of them would turn a good
   * run into a failed one.
   */
  it.each([
    ["no video id", { id: {} }],
    ["a null id", { id: null }],
    ["no snippet", { snippet: null }],
    ["a blank title", { snippet: { title: "   ", channelTitle: "c", publishedAt: null } }],
    ["a blank author", { snippet: { title: "t", channelTitle: "", publishedAt: null } }],
  ])("drops an item with %s and keeps the rest", async (_label, broken) => {
    answers({ items: [item(broken), item({ id: { videoId: "good" } })] });

    const keys = (await provider().search(query())).map((c) => c.itemKey);

    expect(keys).toEqual(["youtube:good"]);
  });

  /** Nothing matched is an answer, not a failure. */
  it.each([
    ["an empty list", { items: [] }],
    ["no items key at all", {}],
    ["a null items key", { items: null }],
  ])("answers with nothing for %s", async (_label, body) => {
    answers(body);

    expect(await provider().search(query())).toEqual([]);
  });
});

describe("an answer that cannot be read", () => {
  it.each([
    ["not an object", "a string"],
    ["null", null],
    ["items that are not a list", { items: "nope" }],
  ])("refuses a body that is %s", async (_label, body) => {
    answers(body);

    const thrown = await provider()
      .search(query())
      .catch((error: unknown) => error);

    expect(isDiscoveryProviderError(thrown)).toBe(true);
    expect((thrown as { reason: string }).reason).toBe("unreadable");
  });

  /** The key travels in the URL, so nothing about a failure may carry either. */
  it("keeps the key out of what a failure says", async () => {
    answers("not an object");

    const thrown = (await provider()
      .search(query())
      .catch((error: unknown) => error)) as Error;

    expect(`${thrown.message} ${String(thrown.stack ?? "")}`).not.toContain(
      API_KEY,
    );
  });
});
