import { describe, expect, it } from "vitest";
import {
  formatRunOutputForDisplay,
  WEBSITE_BASELINE_OUTPUT,
  WEBSITE_UNCHANGED_OUTPUT,
} from "@/lib/run-display";

/**
 * Which stored sentences are AutoOps talking, and which are the account's.
 *
 * **The two conditions are the whole of the safety here**, and most of what
 * follows exists to hold them: the worker has to be a `website` worker, and the
 * output has to be *exactly* one of two sentences. Loosen either — match a
 * prefix, or trust any worker — and AutoOps starts rewriting what a model
 * produced, which is the account's material and is never ours to translate.
 *
 * **Nothing here writes anything.** What is stored is the English sentence in
 * both languages; only the reading changes.
 */

describe("the sentences Koqentra writes for itself", () => {
  it("are exactly what a website run records", () => {
    expect(WEBSITE_BASELINE_OUTPUT).toBe(
      "Website baseline is not established yet.",
    );
    expect(WEBSITE_UNCHANGED_OUTPUT).toBe("Website content has not changed.");
  });
});

describe("a website worker's own two sentences", () => {
  it("reads the first check in English", () => {
    expect(
      formatRunOutputForDisplay(WEBSITE_BASELINE_OUTPUT, "website", "en"),
    ).toBe("Website baseline is not established yet.");
  });

  it("reads the first check in Japanese", () => {
    expect(
      formatRunOutputForDisplay(WEBSITE_BASELINE_OUTPUT, "website", "ja"),
    ).toBe("サイトの初回状態を記録しました。");
  });

  it("reads a check that found nothing in English", () => {
    expect(
      formatRunOutputForDisplay(WEBSITE_UNCHANGED_OUTPUT, "website", "en"),
    ).toBe("Website content has not changed.");
  });

  it("reads a check that found nothing in Japanese", () => {
    expect(
      formatRunOutputForDisplay(WEBSITE_UNCHANGED_OUTPUT, "website", "ja"),
    ).toBe("サイトの内容に変更はありませんでした。");
  });
});

describe("what is never translated", () => {
  /**
   * A website worker that found a change asks a model to describe it. That
   * answer is the worker's product — in whichever language it was written —
   * and passes through untouched.
   */
  it("leaves a website worker's AI summary alone", () => {
    const summary = "The consultation deadline moved to 2026-09-30.";

    for (const language of ["en", "ja"]) {
      expect(formatRunOutputForDisplay(summary, "website", language)).toBe(
        summary,
      );
    }
  });

  it("leaves a prompt worker's output alone", () => {
    const output = "1. Review the roadmap\n2. Reply to the vendor";

    expect(formatRunOutputForDisplay(output, "prompt", "ja")).toBe(output);
  });

  /**
   * **The condition that stops us rewriting somebody's prompt result.** A
   * prompt is written by the account, so an output matching one of our
   * sentences word for word is something they can arrange deliberately.
   */
  it.each([
    ["the first check", WEBSITE_BASELINE_OUTPUT],
    ["a check that found nothing", WEBSITE_UNCHANGED_OUTPUT],
  ])(
    "leaves a prompt worker saying %s exactly alone",
    (_label, sentence) => {
      expect(formatRunOutputForDisplay(sentence, "prompt", "ja")).toBe(sentence);
    },
  );

  it("leaves a worker whose kind cannot be read alone", () => {
    expect(formatRunOutputForDisplay(WEBSITE_UNCHANGED_OUTPUT, null, "ja")).toBe(
      WEBSITE_UNCHANGED_OUTPUT,
    );
  });

  /** Exact means exact: no prefix, no suffix, no substring, no pattern. */
  it.each([
    ["a sentence around it", `Note: ${WEBSITE_UNCHANGED_OUTPUT}`],
    ["something after it", `${WEBSITE_UNCHANGED_OUTPUT} Checked twice.`],
    ["different punctuation", "Website content has not changed"],
    ["different case", "website content has not changed."],
    ["extra whitespace", ` ${WEBSITE_UNCHANGED_OUTPUT} `],
  ])("leaves a website output with %s alone", (_label, output) => {
    expect(formatRunOutputForDisplay(output, "website", "ja")).toBe(output);
  });

  it("leaves any other website output alone", () => {
    expect(formatRunOutputForDisplay("Something else entirely.", "website", "ja")).toBe(
      "Something else entirely.",
    );
  });

  it("leaves an empty output empty", () => {
    expect(formatRunOutputForDisplay("", "website", "ja")).toBe("");
  });
});

/**
 * **The language is the one being read in, not the one in force when the run
 * happened.** Nothing about the stored row records a language, which is what
 * makes this possible — and what makes it impossible for a model's answer,
 * which is stored as written.
 */
describe("changing the language later", () => {
  it("shows the same stored run in whichever language is being read", () => {
    const stored = WEBSITE_UNCHANGED_OUTPUT;

    expect(formatRunOutputForDisplay(stored, "website", "en")).toBe(
      "Website content has not changed.",
    );
    expect(formatRunOutputForDisplay(stored, "website", "ja")).toBe(
      "サイトの内容に変更はありませんでした。",
    );
  });

  it("falls back to English for a language nothing knows", () => {
    expect(formatRunOutputForDisplay(WEBSITE_UNCHANGED_OUTPUT, "website", "fr")).toBe(
      "Website content has not changed.",
    );
  });
});
