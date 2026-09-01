import { describe, expect, it } from "vitest";
import {
  draftToFieldValues,
  injectDraft,
  injectionToken,
  injectTemplate,
} from "@/components/worker-draft-form";
import type { WorkerDraft } from "@/lib/ai/worker-draft";
import { t } from "@/lib/i18n";
import { workerTemplates } from "@/lib/worker-templates";

/**
 * What reaches the form, and what is left behind.
 *
 * This is the half of the connection that can be checked without a browser: the
 * rules about which source wins and which fields travel are decided here, and
 * the component only calls them. The part that cannot be reached — a click
 * turning into a state change — is the reason these functions exist outside it.
 */

const PROMPT_DRAFT: WorkerDraft = {
  kind: "prompt",
  name: "Morning focus",
  description: "Three things to do today.",
  prompt: "List three things worth doing today.",
  frequency: "daily",
  runAtMinutes: 540,
  runAtWeekday: null,
  runAtDay: null,
};

const WEBSITE_DRAFT: WorkerDraft = {
  kind: "website",
  websiteUrl: "https://example.com/news",
  name: "Council notices",
  description: "Watches the notices page.",
  prompt: "Say what changed.",
  frequency: "weekly",
  runAtMinutes: null,
  runAtWeekday: 1,
  runAtDay: null,
};

describe("a prompt draft as form values", () => {
  const values = draftToFieldValues(PROMPT_DRAFT, "paused");

  it("carries the fields the form asks for", () => {
    expect(values).toMatchObject({
      name: "Morning focus",
      description: "Three things to do today.",
      prompt: "List three things worth doing today.",
      frequency: "daily",
      runAtWeekday: null,
      runAtDay: null,
    });
  });

  /** The form's time input takes `HH:mm`, not minutes. */
  it("writes the time the way the field reads it", () => {
    expect(values.runAt).toBe("09:00");
    expect(draftToFieldValues(WEBSITE_DRAFT, undefined).runAt).toBeUndefined();
  });

  /** A prompt worker has no page, and must not arrive carrying one. */
  it("carries no address", () => {
    expect(values.websiteUrl).toBeUndefined();
  });
});

describe("a website draft as form values", () => {
  const values = draftToFieldValues(WEBSITE_DRAFT, undefined);

  it("carries the address the request named", () => {
    expect(values.websiteUrl).toBe("https://example.com/news");
  });

  it("carries the rest of the schedule", () => {
    expect(values).toMatchObject({
      frequency: "weekly",
      runAtWeekday: 1,
      runAtDay: null,
    });
  });
});

/**
 * The one field the model is never asked about.
 *
 * A draft has no status, so applying one answers the questions the model was
 * given and leaves the one it was not — whatever the person had already chosen
 * is what travels through.
 */
describe("status", () => {
  it.each(["draft", "paused", "active"] as const)(
    "keeps %s exactly as it was",
    (status) => {
      expect(draftToFieldValues(PROMPT_DRAFT, status).status).toBe(status);
    },
  );

  it("leaves the field on its own default when there is nothing to keep", () => {
    expect(draftToFieldValues(PROMPT_DRAFT, undefined).status).toBeUndefined();
  });

  it("cannot be set by the draft", () => {
    const withStatus = {
      ...PROMPT_DRAFT,
      status: "active",
    } as unknown as WorkerDraft;

    expect(draftToFieldValues(withStatus, "draft").status).toBe("draft");
  });
});

/**
 * Fields are copied by name, so anything a draft grows later has to be added
 * here before it can reach the form.
 */
describe("what a draft cannot smuggle in", () => {
  it("ignores keys the form does not ask for", () => {
    const extra = {
      ...PROMPT_DRAFT,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      userId: "somebody-else",
      timezone: "Mars/Olympus",
      id: "worker-1",
    } as unknown as WorkerDraft;

    const values = draftToFieldValues(extra, undefined);

    expect(Object.keys(values).sort()).toEqual([
      "description",
      "frequency",
      "name",
      "prompt",
      "runAt",
      "runAtDay",
      "runAtWeekday",
      "status",
      "websiteUrl",
    ]);
    // `runAtMinutes` is deliberately absent: the form field is a time string,
    // and the conversion happens here rather than in the component.
    expect(values).not.toHaveProperty("runAtMinutes");
    expect(JSON.stringify(values)).not.toContain("Mars/Olympus");
    expect(JSON.stringify(values)).not.toContain("somebody-else");
  });
});

/**
 * Which source filled the fields, and when.
 *
 * The token is what actually puts values on screen — it goes into the form's
 * key, and without a new one the uncontrolled fields keep whatever they had.
 */
describe("applying a source", () => {
  it("labels a draft as one", () => {
    const applied = injectDraft(PROMPT_DRAFT, "active", "draft-1");

    expect(applied.source).toBe("draft");
    expect(applied.token).toBe("draft-1");
    expect(applied.values.name).toBe("Morning focus");
  });

  it("labels a template as one, and gives it no status", () => {
    const applied = injectTemplate(workerTemplates[0], "en", "template-1");

    expect(applied.source).toBe("template");
    expect(applied.values.name).toBe(t("en", workerTemplates[0].nameKey));
    expect(applied.values.status).toBeUndefined();
  });

  /**
   * The words come from the dictionary now, so the same template applied by two
   * accounts fills the fields in the language each of them reads.
   */
  it("fills the fields in the language it was asked for", () => {
    const english = injectTemplate(workerTemplates[0], "en", "template-1");
    const japanese = injectTemplate(workerTemplates[0], "ja", "template-2");

    expect(english.values.name).toBe(t("en", workerTemplates[0].nameKey));
    expect(japanese.values.name).toBe(t("ja", workerTemplates[0].nameKey));
    expect(japanese.values.name).not.toBe(english.values.name);
  });

  /** A template must not switch on something that sends mail. */
  it("leaves email notifications alone", () => {
    const applied = injectTemplate(workerTemplates[0], "en", "template-1");

    expect(applied.values.emailNotificationsEnabled).toBeUndefined();
  });

  it("gives every application its own token", () => {
    expect(injectionToken("template", 0)).not.toBe(injectionToken("template", 1));
    expect(injectionToken("draft", 2)).not.toBe(injectionToken("template", 2));
  });

  /**
   * Last-wins is not a rule anybody enforces — the two sources share one box,
   * so applying either simply replaces what was there.
   */
  it("replaces whatever was applied before, in either direction", () => {
    let injected = injectTemplate(
      workerTemplates[0],
      "en",
      injectionToken("template", 0),
    );
    expect(injected.source).toBe("template");

    injected = injectDraft(WEBSITE_DRAFT, "draft", injectionToken("draft", 1));
    expect(injected.source).toBe("draft");
    expect(injected.values.websiteUrl).toBe("https://example.com/news");

    injected = injectTemplate(
      workerTemplates[1],
      "en",
      injectionToken("template", 2),
    );
    expect(injected.source).toBe("template");
    expect(injected.values.websiteUrl).toBeUndefined();
  });
});
