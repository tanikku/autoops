import { describe, expect, it } from "vitest";
import {
  readPublishedAt,
  toDiscoveryCandidate,
  toDiscoveryCandidates,
  youtubeItemKey,
  youtubeWatchUrl,
} from "@/lib/discovery/normalize";

/**
 * What counts as a usable candidate.
 *
 * **No network, and no provider response.** Reading a provider's JSON is the
 * adapter's job; what is fixed here is the judgement after that — given four
 * loose strings, is this a thing somebody could be shown, and is it the same
 * thing next week.
 */

const VIDEO_ID = "dQw4w9WgXcQ";

const ITEM = {
  id: VIDEO_ID,
  title: "ハリネズミの飼い方",
  author: "もふもふチャンネル",
  publishedAt: "2026-09-01T10:00:00.000Z",
};

describe("the key and the address", () => {
  /**
   * **The prefix is not decoration.** Two providers can hand out the same id
   * string meaning different things, and a stored key without a prefix cannot
   * be told apart afterwards — adding one later would mean rewriting every row
   * that already exists.
   */
  it("names the provider in the key", () => {
    expect(youtubeItemKey(VIDEO_ID)).toBe(`youtube:${VIDEO_ID}`);
  });

  it("builds the watch address from the id", () => {
    expect(youtubeWatchUrl(VIDEO_ID)).toBe(
      `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    );
  });
});

describe("when a publication date can be read", () => {
  it("reads an ISO timestamp", () => {
    const at = readPublishedAt("2026-09-01T10:00:00.000Z");

    expect(at).toBeInstanceOf(Date);
    expect(at?.toISOString()).toBe("2026-09-01T10:00:00.000Z");
  });

  it("answers nothing when there was no date", () => {
    expect(readPublishedAt(undefined)).toBeNull();
    expect(readPublishedAt(null)).toBeNull();
    expect(readPublishedAt("")).toBeNull();
    expect(readPublishedAt("   ")).toBeNull();
  });

  it("answers nothing when the date cannot be read", () => {
    expect(readPublishedAt("last Tuesday")).toBeNull();
    expect(readPublishedAt("2026-13-45")).toBeNull();
  });
});

describe("turning one raw item into a candidate", () => {
  it("keeps what is needed and builds the rest", () => {
    const candidate = toDiscoveryCandidate(ITEM);

    expect(candidate).toEqual({
      itemKey: `youtube:${VIDEO_ID}`,
      title: "ハリネズミの飼い方",
      author: "もふもふチャンネル",
      url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      publishedAt: new Date("2026-09-01T10:00:00.000Z"),
    });
  });

  /**
   * Without an id there is no way to say this is the same video tomorrow, so it
   * could be chosen twice and nothing would notice.
   */
  it("refuses an item with no id", () => {
    expect(toDiscoveryCandidate({ ...ITEM, id: undefined })).toBeNull();
    expect(toDiscoveryCandidate({ ...ITEM, id: null })).toBeNull();
    expect(toDiscoveryCandidate({ ...ITEM, id: "" })).toBeNull();
    expect(toDiscoveryCandidate({ ...ITEM, id: "   " })).toBeNull();
  });

  /** Nothing to show, and nothing for a model to judge. */
  it("refuses an item with no title", () => {
    expect(toDiscoveryCandidate({ ...ITEM, title: undefined })).toBeNull();
    expect(toDiscoveryCandidate({ ...ITEM, title: "" })).toBeNull();
    expect(toDiscoveryCandidate({ ...ITEM, title: "  \n " })).toBeNull();
  });

  /**
   * Without an author the rule about not taking two videos from the same person
   * cannot be applied, and a run would quietly return five from one channel.
   */
  it("refuses an item with no author", () => {
    expect(toDiscoveryCandidate({ ...ITEM, author: undefined })).toBeNull();
    expect(toDiscoveryCandidate({ ...ITEM, author: "" })).toBeNull();
    expect(toDiscoveryCandidate({ ...ITEM, author: "\t" })).toBeNull();
  });

  /**
   * **A bad date drops the date, not the candidate.** When a video was
   * published is useful and not essential; refusing the video over it would
   * throw away a result nothing depended on.
   */
  it("keeps a candidate whose date could not be read", () => {
    const candidate = toDiscoveryCandidate({ ...ITEM, publishedAt: "nonsense" });

    expect(candidate?.itemKey).toBe(`youtube:${VIDEO_ID}`);
    expect(candidate?.publishedAt).toBeNull();
  });

  it("trims what it keeps", () => {
    const candidate = toDiscoveryCandidate({
      ...ITEM,
      id: `  ${VIDEO_ID}  `,
      title: "  ハリネズミの飼い方  ",
      author: "  もふもふチャンネル  ",
    });

    expect(candidate?.itemKey).toBe(`youtube:${VIDEO_ID}`);
    expect(candidate?.title).toBe("ハリネズミの飼い方");
    expect(candidate?.author).toBe("もふもふチャンネル");
  });

  /**
   * **The address is built, never quoted.** A provider returning a link is a
   * provider choosing where Koqentra sends somebody; constructing it from the
   * id means the address always names the id it came with.
   */
  it("ignores any address the provider offered", () => {
    const candidate = toDiscoveryCandidate({
      ...ITEM,
      // Not part of RawDiscoveryItem, and that is the point: an extra field
      // cannot become the URL by being present.
      ...({ url: "https://evil.example/watch" } as Record<string, unknown>),
    });

    expect(candidate?.url).toBe(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
  });
});

describe("turning a batch into candidates", () => {
  /**
   * A provider returning twenty items of which three are unreadable has
   * answered the question. Refusing the whole answer over three would turn a
   * good run into a failed one.
   */
  it("drops what it cannot use and keeps the rest", () => {
    const candidates = toDiscoveryCandidates([
      ITEM,
      { ...ITEM, id: "second", title: "" },
      { ...ITEM, id: "third" },
      { id: "", title: "x", author: "y" },
    ]);

    expect(candidates.map((candidate) => candidate.itemKey)).toEqual([
      `youtube:${VIDEO_ID}`,
      "youtube:third",
    ]);
  });

  /**
   * **Order is kept.** The provider was asked for newest first; re-sorting here
   * would silently override what was asked for.
   */
  it("keeps the order they arrived in", () => {
    const candidates = toDiscoveryCandidates([
      { ...ITEM, id: "a" },
      { ...ITEM, id: "b" },
      { ...ITEM, id: "c" },
    ]);

    expect(candidates.map((candidate) => candidate.itemKey)).toEqual([
      "youtube:a",
      "youtube:b",
      "youtube:c",
    ]);
  });

  it("answers with nothing when nothing arrived", () => {
    expect(toDiscoveryCandidates([])).toEqual([]);
  });

  it("answers with nothing when none of it was usable", () => {
    expect(
      toDiscoveryCandidates([
        { id: "", title: "", author: "" },
        { id: "x", title: "", author: "y" },
      ]),
    ).toEqual([]);
  });
});
