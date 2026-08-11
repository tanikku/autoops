import { describe, expect, it } from "vitest";
import { promptVariables, renderPrompt } from "@/lib/prompt";

/**
 * What a prompt's placeholders turn into, and what they deliberately do not.
 *
 * The contract is narrow on purpose: two names are substituted and everything
 * else is left exactly where it is, so a typo shows up in the output instead
 * of quietly becoming an empty string. "Everything else" has to include the
 * names a plain object inherits — those are not variables anyone put there.
 */

const variables = { today: "2026-08-11", now: "2026-08-11T09:10:00.000Z" };

describe("renderPrompt", () => {
  it("substitutes a known variable", () => {
    expect(renderPrompt("Today is {{today}}.", variables)).toBe(
      "Today is 2026-08-11.",
    );
  });

  it("substitutes every occurrence of the same variable", () => {
    expect(renderPrompt("{{today}} and {{today}}", variables)).toBe(
      "2026-08-11 and 2026-08-11",
    );
  });

  it("substitutes different variables in one template", () => {
    expect(renderPrompt("{{today}} at {{now}}", variables)).toBe(
      "2026-08-11 at 2026-08-11T09:10:00.000Z",
    );
  });

  it("leaves an unknown name exactly where it is", () => {
    expect(renderPrompt("Report for {{yesterday}}.", variables)).toBe(
      "Report for {{yesterday}}.",
    );
  });

  /**
   * These read as unknown names to anyone writing a prompt, and they have to
   * behave like unknown names. Asking with `in` answered for the prototype
   * chain and substituted a stringified function into the prompt instead.
   */
  it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"])(
    "leaves the inherited name %s alone",
    (name) => {
      const template = `Value: {{${name}}}`;

      expect(renderPrompt(template, variables)).toBe(template);
    },
  );

  it("does not touch a template with no placeholders", () => {
    const template = "Summarise the week and list the decisions.";

    expect(renderPrompt(template, variables)).toBe(template);
  });

  it("returns an empty prompt unchanged", () => {
    expect(renderPrompt("", variables)).toBe("");
  });

  it.each([
    ["single braces", "{today}"],
    ["spaces inside the braces", "{{ today }}"],
    ["a hyphen in the name", "{{to-day}}"],
    ["an unclosed placeholder", "{{today"],
  ])("leaves %s alone", (_label, template) => {
    expect(renderPrompt(template, variables)).toBe(template);
  });

  it("substitutes what the runtime actually supplies", () => {
    const at = new Date("2026-08-11T09:10:00.000Z");

    expect(renderPrompt("{{today}} / {{now}}", promptVariables(at))).toBe(
      "2026-08-11 / 2026-08-11T09:10:00.000Z",
    );
  });
});

describe("promptVariables", () => {
  it("reads the date and the instant in UTC", () => {
    const at = new Date("2026-08-11T23:30:00.000Z");

    expect(promptVariables(at)).toEqual({
      today: "2026-08-11",
      now: "2026-08-11T23:30:00.000Z",
    });
  });

  /** The date is the UTC one, not the one on the machine's own clock. */
  it("takes the date from the instant rather than from local time", () => {
    expect(promptVariables(new Date("2026-08-11T00:00:00.000Z")).today).toBe(
      "2026-08-11",
    );
  });

  it("offers exactly the two documented names", () => {
    expect(Object.keys(promptVariables()).sort()).toEqual(["now", "today"]);
  });
});
