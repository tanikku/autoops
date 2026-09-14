import { describe, expect, it } from "vitest";
import {
  discoverySourceKinds,
  isDiscoverySourceKind,
} from "@/lib/discovery/types";

/**
 * The guard between a stored string and code that assumes it can be handled.
 *
 * The `source` column is a plain `String`, so a row can hold a provider this
 * deployment has never heard of — written by a later release, or by hand. What
 * these fix is that such a value is refused rather than carried forward into an
 * adapter lookup that would find nothing.
 *
 * Nothing here tests the *type*: that is the compiler's job and a test asserting
 * it would only be asserting that TypeScript works.
 */
describe("which sources a discovery worker can have", () => {
  it("accepts the one provider there is", () => {
    expect(isDiscoverySourceKind("youtube")).toBe(true);
  });

  it("refuses a provider this deployment does not implement", () => {
    expect(isDiscoverySourceKind("vimeo")).toBe(false);
    expect(isDiscoverySourceKind("web-search")).toBe(false);
  });

  /**
   * **Neither is a source.** An empty column and a column holding the word for
   * "none" both mean the row is not usable, and both have to be refused by the
   * same check — nothing downstream looks for either.
   */
  it("refuses the empty string and anything shaped like an absence", () => {
    expect(isDiscoverySourceKind("")).toBe(false);
    expect(isDiscoverySourceKind("null")).toBe(false);
    expect(isDiscoverySourceKind("undefined")).toBe(false);
  });

  /**
   * **Case is not normalised here.** The column is written by Koqentra, so a
   * capitalised value did not come from the form — it came from somewhere that
   * should be noticed rather than quietly accommodated.
   */
  it("does not accept a differently-cased spelling", () => {
    expect(isDiscoverySourceKind("YouTube")).toBe(false);
    expect(isDiscoverySourceKind("YOUTUBE")).toBe(false);
  });

  /**
   * **One entry, on purpose.** A second provider is a decision to make with a
   * second provider in hand. This fails when one is added, which is the moment
   * to check that the adapter, the form and the draft tool all learned about it
   * too.
   */
  it("offers exactly one provider in the MVP", () => {
    expect(discoverySourceKinds).toEqual(["youtube"]);
  });
});
