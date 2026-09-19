import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiscoveryProvider } from "@/lib/discovery/factory";
import { routineKinds, isRoutineKind } from "@/types";
import { readWorkerForm } from "@/lib/worker-input";
import { YouTubeDiscoveryProvider } from "@/lib/discovery/youtube";

/**
 * Whether a source can be asked, answered without asking anybody.
 *
 * **`fetch` is replaced for the whole file**, not because anything here should
 * reach a network but so that a call that did would fail the test rather than
 * leave the machine. Every assertion below expects it never to be called.
 */

const fetchMock = vi.fn();
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  delete process.env.YOUTUBE_API_KEY;
});

afterEach(() => {
  delete process.env.YOUTUBE_API_KEY;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("a source this deployment can reach", () => {
  it("hands back a YouTube provider when a key is configured", () => {
    process.env.YOUTUBE_API_KEY = "yt_test_key_not_a_real_one";

    const availability = createDiscoveryProvider("youtube");

    expect(availability.available).toBe(true);
    expect(
      availability.available && availability.provider,
    ).toBeInstanceOf(YouTubeDiscoveryProvider);
    expect(availability.available && availability.provider.source).toBe("youtube");
  });

  /**
   * **Deciding availability asks nobody.** A request to find out whether this
   * deployment is configured would bill a quota to answer a question about an
   * environment variable.
   */
  it("makes no request to decide", () => {
    process.env.YOUTUBE_API_KEY = "yt_test_key_not_a_real_one";

    createDiscoveryProvider("youtube");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a source this deployment cannot reach", () => {
  it.each([
    ["absent", undefined],
    ["blank", ""],
    ["whitespace", "   "],
  ])("is unavailable when the key is %s", (_label, key) => {
    if (key !== undefined) {
      process.env.YOUTUBE_API_KEY = key;
    }

    const availability = createDiscoveryProvider("youtube");

    expect(availability).toEqual({ available: false, reason: "not-configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * **Fail closed, unlike `createAIProvider`.** A missing model key falls back
   * to a stand-in that answers with a fixed string; a stand-in here would be
   * five links to nothing, recorded as a successful run.
   */
  it.each(["vimeo", "rss", "YouTube", "", "prompt"])(
    "refuses the unknown source %o",
    (source) => {
      expect(createDiscoveryProvider(source)).toEqual({
        available: false,
        reason: "unknown-source",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  /** An unknown source is refused before the key is even looked at. */
  it("refuses an unknown source even with a key configured", () => {
    process.env.YOUTUBE_API_KEY = "yt_test_key_not_a_real_one";

    expect(createDiscoveryProvider("vimeo").available).toBe(false);
  });
});

/**
 * The property this whole phase is measured by.
 *
 * A provider, a trusted client and a selection step now exist. **None of it is
 * reachable**, and these are the assertions that say so — kept here rather than
 * spread across the suites of the modules they name, because what is being
 * fixed is a property of this phase rather than of those modules.
 */
describe("discovery is still dormant", () => {
  it("leaves RoutineKind at prompt and website", () => {
    expect([...routineKinds]).toEqual(["prompt", "website"]);
  });

  it("does not make discovery a routine kind", () => {
    expect(isRoutineKind("discovery")).toBe(false);
  });

  /**
   * **A crafted submission cannot make one.** `readWorkerForm` reads a kind it
   * does not know as null, and every caller that acts on a kind requires one —
   * so a `discovery` in a form post is not a worker of a kind nothing executes.
   */
  it("reads a crafted discovery submission as no kind at all", () => {
    const form = new FormData();
    form.set("name", "Crafted");
    form.set("kind", "discovery");

    expect(readWorkerForm(form).kind).toBeNull();
  });

  /**
   * **Nothing requires the key at boot.** It is read when a provider is asked
   * for, which nothing does; an unset variable makes discovery unavailable
   * rather than stopping the application.
   */
  it("needs no key to be imported or asked", () => {
    expect(process.env.YOUTUBE_API_KEY).toBeUndefined();
    expect(() => createDiscoveryProvider("youtube")).not.toThrow();
  });
});
