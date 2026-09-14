import { describe, expect, it } from "vitest";
import {
  DISCOVERY_DEFAULT_MAX_RESULTS,
  DISCOVERY_MAX_CANDIDATES,
  DISCOVERY_MAX_RESULTS_CEILING,
  DISCOVERY_PUBLISHED_WITHIN_DAYS,
  DISCOVERY_QUERY_MAX_CHARS,
} from "@/lib/discovery/limits";

/**
 * The numbers, as they were decided.
 *
 * **These assert values rather than behaviour, which is unusual and deliberate.**
 * Four of the five are product decisions taken outside this repository — how
 * many results a run may pick, how far back "new" reaches — and a decision
 * nobody can see being changed is a decision that gets changed by accident. A
 * failure here is not a bug; it is a prompt to say who decided otherwise.
 */
describe("what bounds a discovery run", () => {
  it("holds a search phrase to the length of a title", () => {
    expect(DISCOVERY_QUERY_MAX_CHARS).toBe(300);
  });

  it("picks five when nobody says otherwise", () => {
    expect(DISCOVERY_DEFAULT_MAX_RESULTS).toBe(5);
  });

  it("never picks more than ten, whatever the owner set", () => {
    expect(DISCOVERY_MAX_RESULTS_CEILING).toBe(10);
  });

  it("looks at twenty-five candidates before choosing", () => {
    expect(DISCOVERY_MAX_CANDIDATES).toBe(25);
  });

  it("counts the last thirty days as new", () => {
    expect(DISCOVERY_PUBLISHED_WITHIN_DAYS).toBe(30);
  });

  /**
   * **The two are not the same number and must not cross.** A default above the
   * ceiling would make every new worker invalid on the form that created it;
   * a ceiling above the candidate count would let somebody ask for more items
   * than a run ever looks at, and get fewer than they asked for every time
   * without being told why.
   */
  it("keeps the default under the ceiling, and the ceiling under what it looks at", () => {
    expect(DISCOVERY_DEFAULT_MAX_RESULTS).toBeLessThanOrEqual(
      DISCOVERY_MAX_RESULTS_CEILING,
    );
    expect(DISCOVERY_MAX_RESULTS_CEILING).toBeLessThan(
      DISCOVERY_MAX_CANDIDATES,
    );
  });

  /** A bound of zero or less is not a bound; it is a feature that never runs. */
  it("states every bound as a positive number", () => {
    for (const limit of [
      DISCOVERY_QUERY_MAX_CHARS,
      DISCOVERY_DEFAULT_MAX_RESULTS,
      DISCOVERY_MAX_RESULTS_CEILING,
      DISCOVERY_MAX_CANDIDATES,
      DISCOVERY_PUBLISHED_WITHIN_DAYS,
    ]) {
      expect(limit).toBeGreaterThan(0);
      expect(Number.isInteger(limit)).toBe(true);
    }
  });
});
