import { describe, expect, it } from "vitest";
import { t } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import { ja } from "@/lib/i18n/ja";
import {
  templatesOfKind,
  workerTemplates,
  type WorkerTemplate,
} from "@/lib/worker-templates";
import { injectTemplate } from "@/components/worker-draft-form";
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
  it("offers nine examples", () => {
    expect(workerTemplates).toHaveLength(9);
  });

  it("offers five for watching a page", () => {
    expect(templatesOfKind("website")).toHaveLength(5);
  });

  it("offers three for asking a model", () => {
    expect(templatesOfKind("prompt")).toHaveLength(3);
  });

  it("offers one for having things found", () => {
    expect(templatesOfKind("discovery")).toHaveLength(1);
  });

  it("puts every example in exactly one group", () => {
    expect(
      templatesOfKind("website").length +
        templatesOfKind("prompt").length +
        templatesOfKind("discovery").length,
    ).toBe(workerTemplates.length);
  });

  it("gives each one an id nothing else has", () => {
    const ids = workerTemplates.map((template) => template.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("says which kind each one makes", () => {
    for (const template of workerTemplates) {
      expect(["website", "prompt", "discovery"]).toContain(template.kind);
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
   *
   * **The place is a heading with nothing after it.** It used to be a marker —
   * `(write yours here)` — and in production a worker went out with the marker
   * still in: the model read it as the material, said correctly that it had
   * none, and the run was recorded as a success. A heading followed by a blank
   * line cannot be left behind, because there is nothing there to leave.
   */
  it.each(LANGUAGES)("ends on somewhere to write the material, in %s", (language) => {
    for (const template of prompts) {
      const { prompt } = words(template, language);

      expect(prompt.trimEnd(), template.id).toMatch(/:$/);
    }
  });

  /**
   * **The failure mode is gone from the copy, not guarded against in code.**
   * Nothing in the product looks for these strings; this is the one place that
   * would notice them coming back.
   */
  it.each(LANGUAGES)("leaves no marker to be forgotten, in %s", (language) => {
    for (const template of prompts) {
      const { prompt } = words(template, language);

      expect(prompt, template.id).not.toMatch(/\(write yours here\)/);
      expect(prompt, template.id).not.toMatch(/\(ここに書いてください\)/);
    }
  });

  /**
   * **`lib/prompt.ts` resolves two names and leaves every other one where it
   * is.** So a `{topic}` written to look like a slot would travel to the model
   * exactly as typed, and the model would be asked about a brace. Plainer copy
   * must not reach for a variable system that does not exist.
   */
  it.each(LANGUAGES)("asks for no variable the engine does not have, in %s", (language) => {
    for (const template of prompts) {
      const { prompt } = words(template, language);

      for (const [, name] of prompt.matchAll(/\{\{(\w+)\}\}/g)) {
        expect(["today", "now"], `${template.id}: {{${name}}}`).toContain(name);
      }

      // A single brace is not a variable at all — `renderPrompt` only reads
      // doubled ones — so one here is a slot somebody expected to be filled.
      expect(
        prompt.replace(/\{\{\w+\}\}/g, ""),
        template.id,
      ).not.toMatch(/[{}]/);
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
 * **One thing is always left for the person**, and which one depends on the
 * kind: a website example leaves the address, a discovery example leaves the
 * search. Both are checked twice — rejected without it, and accepted with it.
 * That is the existing rule rather than a new one: `validateWorkerFormForKind`
 * is called here exactly as the hire action calls it.
 */
describe("what the form makes of an applied template", () => {
  function applied(template: WorkerTemplate, language: string): WorkerFormInput {
    return {
      name: t(language, template.nameKey),
      description: "",
      prompt: t(language, template.promptKey),
      websiteUrl: "",
      // **The source is what the form submits for a discovery worker**, hidden
      // and fixed; the search is the blank it leaves for the person. See the
      // two assertions below.
      discoverySource: template.kind === "discovery" ? "youtube" : "",
      discoveryQuery: "",
      discoveryMaxResults: null,
      discoveryMaxResultsSubmitted: false,
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
      const discoveryQuery =
        template.kind === "discovery" ? "ハリネズミ" : "";

      const errors = validateWorkerFormForKind(
        { ...values, websiteUrl, discoveryQuery },
        { status: "active", frequency: template.defaultFrequency },
        template.kind,
        language,
      );

      expect(errors, template.id).toEqual({});
    }
  });

  /** The search is still asked for, which is what leaves it to the person. */
  it("still requires a search of a discovery worker", () => {
    for (const template of templatesOfKind("discovery")) {
      const errors = validateWorkerFormForKind(
        applied(template, "en"),
        { status: "draft", frequency: template.defaultFrequency },
        "discovery",
        "en",
      );

      expect(errors.discoveryQuery, template.id).toBeTruthy();
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

/**
 * What the presets deliberately do not offer.
 *
 * **Discovery is runnable and not offerable**, and those are different
 * questions. Execution has a branch for it, `isRoutineKind` accepts it, and a
 * stored worker of that kind runs — but nothing on the hire form makes one, and
 * a template that did would be the first thing to.
 *
 * Fixed here rather than left to the eye, because a template is one line in an
 * array and this is the file that would notice.
 */
/**
 * The discovery example, and the two things it deliberately leaves out.
 *
 * **This block used to say no template made a discovery worker**, which was the
 * boundary the phase before this one held. It has been replaced rather than
 * kept: the hire form now offers the kind, so a template for it is the ordinary
 * thing rather than the exception.
 */
describe("the discovery example", () => {
  const discovery = workerTemplates.find(
    (template) => template.id === "recommendation-finder",
  );

  it("exists, and makes a discovery worker every day", () => {
    expect(discovery).toBeDefined();
    expect(discovery?.kind).toBe("discovery");
    expect(discovery?.defaultFrequency).toBe("daily");
  });

  /**
   * **No provider in the name.** YouTube is what this version asks; a second
   * one should be a stored value rather than a rename of the example.
   */
  it.each(["en", "ja"] as const)("names no provider in %s", (language) => {
    const name = t(language, discovery!.nameKey);
    const description = t(language, discovery!.descriptionKey);

    expect(`${name} ${description}`.toLowerCase()).not.toContain("youtube");
  });

  /**
   * **It carries no search**, for the reason a website template carries no
   * address: what to look for is the one thing only the person choosing knows.
   */
  it("fills in everything except what to look for", () => {
    const values = injectTemplate(discovery!, "ja", "token");

    expect(values.values.prompt).not.toBe("");
    expect(values.values.discoveryQuery ?? "").toBe("");
  });

  /** The default count lives on the form, not repeated here. */
  it("sets no count of its own", () => {
    expect(injectTemplate(discovery!, "en", "token").values.discoveryMaxResults)
      .toBeUndefined();
  });

  it.each(["en", "ja"] as const)(
    "says how to choose rather than what to choose, in %s",
    (language) => {
      const instruction = t(language, discovery!.promptKey);

      expect(instruction.trim()).not.toBe("");
      // Nothing that claims the model watched, read or judged quality.
      for (const overclaim of ["視聴", "内容を確認", "質が高い", "watched", "high quality"]) {
        expect(instruction).not.toContain(overclaim);
      }
    },
  );
});
