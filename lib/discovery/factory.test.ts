import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiscoveryProvider } from "@/lib/discovery/factory";
import { en } from "@/lib/i18n/en";
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
 * What changed when the runtime arrived, and what deliberately did not.
 *
 * **These assertions used to say discovery was unreachable**, and that was the
 * property the phase before this one was measured by. It has been replaced
 * rather than kept: a kind is now accepted, a crafted submission now reads as
 * one, and execution has a branch for it. Leaving the old expectations behind
 * would have left a suite asserting a dormancy that no longer holds.
 *
 * **What has not changed is the key.** Nothing reads `YOUTUBE_API_KEY` at boot,
 * and a deployment without one has a discovery kind that can be named and a
 * provider that refuses — which is what the last two tests here fix.
 */
describe("discovery after the runtime arrived", () => {
  it("is a routine kind execution has a branch for", () => {
    expect([...routineKinds]).toEqual(["prompt", "website", "discovery"]);
    expect(isRoutineKind("discovery")).toBe(true);
  });

  /** A submission naming the kind now reads as that kind rather than as null. */
  it("reads a discovery submission as the discovery kind", () => {
    const form = new FormData();
    form.set("name", "Recommendations");
    form.set("kind", "discovery");

    expect(readWorkerForm(form).kind).toBe("discovery");
  });

  /**
   * **Still nothing at boot.** The key is read when a provider is asked for,
   * and an unset variable makes the source unavailable rather than stopping the
   * application — which is what lets this phase ship before the key is set.
   */
  it("needs no key to be imported or asked", () => {
    expect(process.env.YOUTUBE_API_KEY).toBeUndefined();
    expect(() => createDiscoveryProvider("youtube")).not.toThrow();
  });

  /**
   * **The UI boundary, now crossed.** A kind being runnable and a kind being
   * offerable are different things, and they arrived one phase apart: the
   * runtime shipped while the hire form still showed two options, and the third
   * option came with the form that can configure it. What the factory answers
   * did not change either time — availability is still decided by a variable,
   * and still without asking anybody.
   */
  it("is offered as a kind to choose on the hire form", () => {
    expect(Object.keys(en)).toContain("worker.kind.discoveryOption");
  });

  /**
   * **The form does not gate on availability**, which is the decision worth
   * fixing here: no screen says whether a key is configured, and a deployment
   * without one refuses at the create action rather than by hiding the option.
   * A UI that hid it would be a second source of truth for the same question.
   */
  it("is offered whether or not this deployment has a key", () => {
    expect(process.env.YOUTUBE_API_KEY).toBeUndefined();
    expect(createDiscoveryProvider("youtube")).toEqual({
      available: false,
      reason: "not-configured",
    });
    expect(Object.keys(en)).toContain("worker.kind.discoveryOption");
  });
});
