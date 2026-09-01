import { describe, expect, it } from "vitest";
import { t } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import { ja } from "@/lib/i18n/ja";
import {
  templatesOfKind,
  workerTemplates,
  type WorkerTemplate,
} from "@/lib/worker-templates";
import { validateWorkerFormForKind, workerFieldLimits } from "@/lib/worker-input";
import type { WorkerFormInput } from "@/lib/worker-input";

/**
 * What the examples promise, held against what a worker can actually do.
 *
 * **This is the check that was missing when the templates last went wrong.**
 * Three of the five before this set were written as though AutoOps would go and
 * find things — an inbox, the day's news, a topic researched with sources — and
 * nothing failed, because a template is copy and copy compiles. The rules below
 * are the ones that were being broken then, written down so that breaking them
 * again is a red test rather than a screen nobody re-read.
 */

const LANGUAGES = ["en", "ja"] as const;

/** Every string a template puts on screen or into the form, in one language. */
function words(template: WorkerTemplate, language: string) {
  return {
    name: t(language, template.nameKey),
    description: t(language, template.descriptionKey),
    prompt: t(language, template.promptKey),
  };
}

describe("what the set is made of", () => {
  it("offers eight examples", () => {
    expect(workerTemplates).toHaveLength(8);
  });

  it("offers five for watching a page", () => {
    expect(templatesOfKind("website")).toHaveLength(5);
  });

  it("offers three for asking a model", () => {
    expect(templatesOfKind("prompt")).toHaveLength(3);
  });

  it("puts every example in exactly one group", () => {
    expect(
      templatesOfKind("website").length + templatesOfKind("prompt").length,
    ).toBe(workerTemplates.length);
  });

  it("gives each one an id nothing else has", () => {
    const ids = workerTemplates.map((template) => template.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("says which kind each one makes", () => {
    for (const template of workerTemplates) {
      expect(["website", "prompt"]).toContain(template.kind);
    }
  });
});

/**
 * **A template is offered in the language of whoever is reading it**, which is
 * enforced by the dictionary rather than by this file: the keys are
 * `TranslationKey`s, so a missing Japanese line does not compile. What is
 * checked here is that each key was actually filled in rather than falling back
 * to its own name.
 */
describe("both languages", () => {
  it.each(LANGUAGES)("has every example's words in %s", (language) => {
    for (const template of workerTemplates) {
      const { name, description, prompt } = words(template, language);

      for (const [field, value] of Object.entries({ name, description, prompt })) {
        expect(value.trim(), `${template.id}.${field}`).not.toBe("");
        // `t()` answers with the key itself when nothing is behind it.
        expect(value, `${template.id}.${field}`).not.toContain("template.");
      }
    }
  });

  it("says something different in Japanese", () => {
    for (const template of workerTemplates) {
      expect(words(template, "ja").name).not.toBe(words(template, "en").name);
      expect(words(template, "ja").description).not.toBe(
        words(template, "en").description,
      );
    }
  });

  /** Both dictionaries hold the same set of template keys, key for key. */
  it("keeps the two dictionaries in step", () => {
    const templateKeys = Object.keys(en).filter((key) =>
      key.startsWith("template."),
    );

    expect(templateKeys.length).toBeGreaterThan(0);
    for (const key of templateKeys) {
      expect(Object.keys(ja)).toContain(key);
    }
  });
});

describe("what a website example says", () => {
  const website = templatesOfKind("website");

  /**
   * **The value being described is the summary, not the checking.** A page that
   * changed is only worth anything once somebody is told what changed, and the
   * description is where that is promised.
   */
  it.each(LANGUAGES)("promises that AI sums the change up, in %s", (language) => {
    for (const template of website) {
      const description = words(template, language);
      const summarises =
        language === "en"
          ? /AI sums up/i.test(description.description)
          : /AI が/.test(description.description) &&
            /まとめ/.test(description.description);

      expect(summarises, `${template.id}`).toBe(true);
    }
  });

  it.each(LANGUAGES)("says it checks a page regularly, in %s", (language) => {
    for (const template of website) {
      const { description } = words(template, language);
      const periodic =
        language === "en"
          ? /regularly/i.test(description)
          : /定期的に確認/.test(description);

      expect(periodic, `${template.id}`).toBe(true);
    }
  });

  /**
   * **A watcher fetches the one address it was given.** Nothing searches, and
   * nothing collects from anywhere else — an example that implied either would
   * be describing a product that does not exist, which is exactly what the
   * previous set did.
   */
  it.each(LANGUAGES)("never suggests searching or collecting, in %s", (language) => {
    const forbidden =
      language === "en"
        ? [/\bsearch(es|ing)?\b/i, /\bcrawl/i, /across the web/i, /\bgather/i]
        : [/検索/, /巡回/, /収集/, /ネット中/, /Web 全体/];

    for (const template of website) {
      const { name, description, prompt } = words(template, language);

      for (const pattern of forbidden) {
        expect(`${name} ${description} ${prompt}`, `${template.id}`).not.toMatch(
          pattern,
        );
      }
    }
  });

  /** Which page to watch is the one thing only the person choosing can know. */
  it("names no address", () => {
    for (const template of website) {
      for (const language of LANGUAGES) {
        const { prompt, description } = words(template, language);

        expect(`${prompt} ${description}`).not.toContain("http");
      }
    }
  });

  /** A page changes on its own, so a cadence is what makes watching it useful. */
  it("comes on a cadence rather than waiting to be asked", () => {
    for (const template of website) {
      expect(template.defaultFrequency, template.id).not.toBe("manual");
    }
  });
});

describe("what a prompt example says", () => {
  const prompts = templatesOfKind("prompt");

  /**
   * **There is no inbox, no calendar, no file and no search behind any of
   * these.** A prompt worker is one call to a model with the words it holds, so
   * an example that named a source outside the prompt would be promising a
   * connection nothing implements.
   */
  it.each(LANGUAGES)("never suggests fetching anything, in %s", (language) => {
    const forbidden =
      language === "en"
        ? [
            /\bemail/i,
            /\binbox/i,
            /\bcalendar/i,
            /\bslack/i,
            /\bsearch(es|ing)?\b/i,
            /\bfetch/i,
            /\bbrowse/i,
            /\bfrom the web\b/i,
          ]
        : [
            /メール/,
            /受信箱/,
            /カレンダー/,
            /Slack/,
            /検索/,
            /取得/,
            /収集/,
            /自動で集め/,
          ];

    for (const template of prompts) {
      const { name, description, prompt } = words(template, language);

      for (const pattern of forbidden) {
        expect(`${name} ${description} ${prompt}`, `${template.id}`).not.toMatch(
          pattern,
        );
      }
    }
  });

  /**
   * **Each carries the place its material goes.** Without one, a worker on a
   * cadence would run against instructions with nothing to work from and
   * complete anyway — nothing in the pipeline can tell an answer from an
   * invention.
   */
  it.each(LANGUAGES)("leaves somewhere to write the material, in %s", (language) => {
    for (const template of prompts) {
      const { prompt } = words(template, language);

      expect(prompt, template.id).toMatch(/---/);
      expect(prompt, template.id).toMatch(
        language === "en" ? /\(write yours here\)/ : /\(ここに書いてください\)/,
      );
    }
  });
});

/**
 * **A prompt variable is not a translation placeholder.** `t()` only
 * substitutes when it is given values and nothing asks for these with any, so
 * the doubled braces survive to `lib/prompt.ts` — where they are resolved at
 * run time.
 */
describe("prompt variables", () => {
  it("keeps {{today}} and {{now}} intact in both languages", () => {
    const withVariables = workerTemplates.filter((template) =>
      /\{\{(today|now)\}\}/.test(t("en", template.promptKey)),
    );

    expect(withVariables.length).toBeGreaterThan(0);

    for (const template of withVariables) {
      for (const language of LANGUAGES) {
        expect(t(language, template.promptKey), template.id).toMatch(
          /\{\{(today|now)\}\}/,
        );
      }
    }
  });
});

/**
 * What a template produces has to be something the form would accept.
 *
 * **The address is the one thing left for the person**, so a website example is
 * checked twice: rejected without one, and accepted with one. That is the
 * existing rule rather than a new one — `validateWorkerFormForKind` is called
 * here exactly as the hire action calls it.
 */
describe("what the form makes of an applied template", () => {
  function applied(template: WorkerTemplate, language: string): WorkerFormInput {
    return {
      name: t(language, template.nameKey),
      description: "",
      prompt: t(language, template.promptKey),
      websiteUrl: "",
      kind: template.kind,
      status: null,
      frequency: template.defaultFrequency,
      runAtMinutes: null,
      runAtWeekday: null,
      runAtDay: null,
      emailNotificationsEnabled: false,
    };
  }

  it.each(LANGUAGES)("fits inside every field limit, in %s", (language) => {
    for (const template of workerTemplates) {
      const values = applied(template, language);

      expect(values.name.length, template.id).toBeLessThanOrEqual(
        workerFieldLimits.name,
      );
      expect(values.prompt.length, template.id).toBeLessThanOrEqual(
        workerFieldLimits.prompt,
      );
    }
  });

  it.each(LANGUAGES)("passes validation once a worker is finished, in %s", (language) => {
    for (const template of workerTemplates) {
      const values = applied(template, language);
      const websiteUrl =
        template.kind === "website" ? "https://example.com/news" : "";

      const errors = validateWorkerFormForKind(
        { ...values, websiteUrl },
        { status: "active", frequency: template.defaultFrequency },
        template.kind,
        language,
      );

      expect(errors, template.id).toEqual({});
    }
  });

  /** The address is still asked for, which is what leaves it to the person. */
  it("still requires an address of a website worker", () => {
    for (const template of templatesOfKind("website")) {
      const errors = validateWorkerFormForKind(
        applied(template, "en"),
        { status: "draft", frequency: template.defaultFrequency },
        "website",
        "en",
      );

      expect(errors.websiteUrl, template.id).toBeTruthy();
    }
  });

  /**
   * **No template turns email on.** The default belongs to the schema and to
   * the person, and an example that switched it on would be sending mail on
   * behalf of somebody who only pressed a card.
   */
  it("leaves email notifications where the schema put them", () => {
    for (const template of workerTemplates) {
      expect(Object.keys(template)).not.toContain("emailNotificationsEnabled");
    }
  });
});
