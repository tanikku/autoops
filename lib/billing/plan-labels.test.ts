import { describe, expect, it } from "vitest";
import { planNameKey, planNameKeyFor } from "@/lib/billing/plan-labels";
import { en } from "@/lib/i18n/en";
import { planIds } from "@/lib/plans";

/**
 * What a plan is called, read by both screens that name one.
 *
 * **The point of the module is that there is one table.** When the mapping lived
 * inside the plan cards, the heading above them fell back to the stored id and
 * one screen called the same plan both `Lite` and `lite`. The tests below fix
 * that every plan has a name and that the name comes from the dictionary.
 */

describe("which plans can be named", () => {
  /** Including the two nobody buys: an account can be on either. */
  it("names every plan in the catalogue", () => {
    for (const plan of planIds) {
      expect(planNameKey(plan), plan).not.toBeNull();
    }
  });

  it("names the two that are granted rather than bought", () => {
    expect(planNameKey("trial")).toBe("pricing.plan.trial");
    expect(planNameKey("beta")).toBe("pricing.plan.beta");
  });

  it("names the three that are sold", () => {
    expect(planNameKey("lite")).toBe("pricing.plan.lite");
    expect(planNameKey("standard")).toBe("pricing.plan.standard");
    expect(planNameKey("pro")).toBe("pricing.plan.pro");
  });

  /** A key the dictionary does not hold would be a blank on a screen. */
  it("names each plan with a key the dictionary holds", () => {
    for (const plan of planIds) {
      const key = planNameKey(plan);

      expect(key, plan).not.toBeNull();
      expect(en[key!], plan).toBeTypeOf("string");
    }
  });

  /** The name is chosen, not derived: `Lite`, never the stored `lite`. */
  it("gives a name written the way a card writes it", () => {
    expect(en[planNameKeyFor("lite")]).toBe("Lite");
    expect(en[planNameKeyFor("beta")]).toBe("Beta");
  });
});

/**
 * **Null rather than a guess.** A plan id a newer version wrote is not a plan to
 * name from its id; the caller says "cannot be shown" instead, which is the
 * answer a screen already gives for a stored state it cannot read.
 */
describe("a plan this build does not know", () => {
  it.each(["enterprise", "Lite", "", "free"])("is not named: %s", (plan) => {
    expect(planNameKey(plan)).toBeNull();
  });
});
